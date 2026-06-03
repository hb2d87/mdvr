from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from pydantic import BaseModel, validator
from typing import Any, List, Set, Dict, Tuple, Optional
import os
import re
import shutil
import json
import yaml
import asyncio
import threading
import mimetypes
import urllib.parse
import logging
import tempfile
import time
import base64
import binascii
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

MAX_CONTENT_SIZE = 10 * 1024 * 1024  # 10 MB
logger = logging.getLogger("mdvr")

app = FastAPI(docs_url=None, redoc_url=None)  # Disable docs in production

# --- WebSocket live-sync via watchdog ---
connected_clients: Dict[int, WebSocket] = {}
event_loop = None  # Will be set on startup

# Lightweight in-memory caches to avoid rescanning the vault on repeated
# requests during the same UI session. These are invalidated on any file-system
# event or write operation so the data stays fresh.
cache_lock = threading.RLock()
vault_names_cache: Optional[List[Dict[str, str]]] = None
file_tree_cache: Dict[str, List['FileItem']] = {}
folder_children_cache: Dict[Tuple[str, str], List[Dict]] = {}
recent_files_cache: Dict[str, List[Dict]] = {}
vault_index_cache: Dict[str, Tuple[List[Dict], Dict[str, Dict], Dict[str, List[Dict]], Dict[str, List[Dict]]]] = {}
vault_options_cache: Optional[List[Dict[str, str]]] = None
mdvr_config_cache: Optional[Tuple[str, float, Dict]] = None

VAULT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
CONFIG_TOP_KEYS = {"app", "server", "defaults", "vaults", "auth", "permissions"}
APP_KEYS = {"name", "description"}
SERVER_KEYS = {"auth", "unknown_keys", "write_without_auth", "host", "port"}
AUTH_KEYS = {"enabled", "realm", "user", "password", "file"}
DEFAULTS_KEYS = {"mode", "permissions"}
VAULT_KEYS = {"id", "name", "description", "path", "mode", "permissions"}
PERMISSION_KEYS = {
    "read", "edit", "new_files", "rename", "delete", "hide_read",
    "files_format_read", "files_format_edit", "files_format_new",
}
MODE_PERMISSIONS: Dict[str, Dict[str, Any]] = {
    "read-only": {
        "read": True,
        "edit": False,
        "new_files": False,
        "rename": False,
        "delete": False,
        "hide_read": False,
        "files_format_read": [".md", ".markdown", ".excalidraw", ".txt"],
        "files_format_edit": [".md", ".markdown", ".excalidraw", ".txt"],
        "files_format_new": [".md", ".markdown", ".excalidraw", ".txt"],
    },
    "read-write": {
        "read": True,
        "edit": True,
        "new_files": True,
        "rename": True,
        "delete": False,
        "hide_read": False,
        "files_format_read": [".md", ".markdown", ".excalidraw", ".txt"],
        "files_format_edit": [".md", ".markdown", ".excalidraw", ".txt"],
        "files_format_new": [".md", ".markdown", ".excalidraw", ".txt"],
    },
    "admin": {
        "read": True,
        "edit": True,
        "new_files": True,
        "rename": True,
        "delete": True,
        "hide_read": False,
        "files_format_read": [".md", ".markdown", ".excalidraw", ".txt"],
        "files_format_edit": [".md", ".markdown", ".excalidraw", ".txt"],
        "files_format_new": [".md", ".markdown", ".excalidraw", ".txt"],
    },
}


def invalidate_vault_caches() -> None:
    global vault_names_cache, vault_options_cache, mdvr_config_cache
    with cache_lock:
        vault_names_cache = None
        vault_options_cache = None
        mdvr_config_cache = None
        file_tree_cache.clear()
        folder_children_cache.clear()
        recent_files_cache.clear()
        vault_index_cache.clear()


class VaultOption(BaseModel):
    value: str
    label: str
    path: str
    id: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None


class FileItem(BaseModel):
    name: str
    path: str
    is_dir: bool
    children: Optional[List["FileItem"]] = None


class FileWriteRequest(BaseModel):
    path: str
    content: str = ""

    @validator("content")
    def content_size(cls, value: str) -> str:
        if len(value.encode("utf-8")) > MAX_CONTENT_SIZE:
            raise ValueError("File content is too large")
        return value


class AssetUploadRequest(BaseModel):
    filename: str
    content_type: str = ""
    content_base64: str
    current_path: str = ""


class RenameRequest(BaseModel):
    old_path: str
    new_path: str

class VaultEventHandler(FileSystemEventHandler):
    """Watches the vault directory and pushes change events to all WS clients."""
    def __init__(self, vault_path: str):
        self.vault_path = vault_path

    def _make_event(self, event_type: str, src_path: str, dest_path: Optional[str] = None):
        rel = os.path.relpath(src_path, self.vault_path)
        # Skip hidden files/dirs
        if any(part.startswith('.') and part != '.metadata' for part in rel.split(os.sep)):
            return None
        payload = {"type": event_type, "path": rel, "is_dir": os.path.isdir(src_path)}
        if dest_path:
            payload["dest"] = os.path.relpath(dest_path, self.vault_path)
        return payload

    def _broadcast(self, payload):
        if payload is None or event_loop is None:
            return
        invalidate_vault_caches()
        asyncio.run_coroutine_threadsafe(_broadcast_event(payload), event_loop)

    def on_created(self, event):
        self._broadcast(self._make_event("created", event.src_path))
    def on_modified(self, event):
        self._broadcast(self._make_event("modified", event.src_path))
    def on_deleted(self, event):
        self._broadcast(self._make_event("deleted", event.src_path))
    def on_moved(self, event):
        self._broadcast(self._make_event("moved", event.src_path, event.dest_path))

async def _broadcast_event(payload):
    dead: List[int] = []
    msg = json.dumps(payload)
    for client_id, ws in list(connected_clients.items()):
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(client_id)
    for client_id in dead:
        connected_clients.pop(client_id, None)

@app.on_event("startup")
def start_watcher():
    global event_loop
    event_loop = asyncio.get_event_loop()
    vault = _get_vault_base_path()
    if os.path.isdir(vault):
        handler = VaultEventHandler(vault)
        observer = Observer()
        observer.schedule(handler, vault, recursive=True)
        observer.daemon = True
        observer.start()

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    client_id = id(ws)
    connected_clients[client_id] = ws
    try:
        while True:
            await ws.receive_text()  # keep alive; client can send pings
    except WebSocketDisconnect:
        connected_clients.pop(client_id, None)

class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'SAMEORIGIN'
        response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
        return response

app.add_middleware(SecurityHeadersMiddleware)

# Vault path - will be mounted in container
VAULT_PATH = os.environ.get("VAULT_PATH", "/vault")
MARKDOWN_FILE_EXTENSIONS = {".md", ".markdown", ".mdown", ".mkdn"}
EXCALIDRAW_FILE_EXTENSIONS = {".excalidraw"}
TEXT_FILE_EXTENSIONS = {
    ".txt", ".csv", ".tsv", ".json", ".log", ".ini", ".conf", ".cfg", ".sh", ".bash",
    ".py", ".js", ".ts", ".html", ".htm", ".css", ".yaml", ".yml", ".toml", ".xml",
    ".env", ".sql", ".rb", ".go", ".rs", ".java", ".c", ".h", ".hpp", ".cpp",
}
IMAGE_FILE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"}
VISIBLE_FILE_EXTENSIONS = MARKDOWN_FILE_EXTENSIONS | EXCALIDRAW_FILE_EXTENSIONS | TEXT_FILE_EXTENSIONS | IMAGE_FILE_EXTENSIONS


def is_hidden_name(name: str) -> bool:
    return name.startswith('.')


def get_file_extension(path: str) -> str:
    return os.path.splitext(path or "")[-1].lower()


def is_markdown_file(path: str) -> bool:
    return get_file_extension(path) in MARKDOWN_FILE_EXTENSIONS


def is_excalidraw_file(path: str) -> bool:
    return get_file_extension(path) in EXCALIDRAW_FILE_EXTENSIONS


def is_text_like_file(path: str) -> bool:
    return is_markdown_file(path) or is_excalidraw_file(path) or get_file_extension(path) in TEXT_FILE_EXTENSIONS


def is_image_file(path: str) -> bool:
    return get_file_extension(path) in IMAGE_FILE_EXTENSIONS


def get_file_kind(path: str) -> str:
    if is_image_file(path):
        return "image"
    if is_excalidraw_file(path):
        return "excalidraw"
    if is_markdown_file(path):
        return "markdown"
    if is_text_like_file(path):
        return "text"
    return "binary"


def is_visible_file(name: str) -> bool:
    return not is_hidden_name(name) and get_file_extension(name) in VISIBLE_FILE_EXTENSIONS


def is_visible_dir(name: str) -> bool:
    return not is_hidden_name(name)


def resolve_vault_root(request: Request) -> str:
    """Resolve the active vault to an absolute path under the configured registry."""
    base = _get_vault_base_path()
    raw = (request.headers.get("x-vault-path") or request.query_params.get("vault") or "").strip().replace("\\", "/")

    options = build_vault_options()
    has_configured_vaults = bool(options) and not any(option["value"] == "/" for option in options)
    if has_configured_vaults and raw in ("", "/"):
        return options[0]["path"]

    by_value = {option["value"]: option["path"] for option in options}
    if raw in by_value:
        return by_value[raw]

    if has_configured_vaults:
        raise HTTPException(status_code=404, detail="Vault not found")

    if raw in ("", "/"):
        return base

    normalized = normalize_rel_path(raw)
    if normalized:
        target = os.path.realpath(os.path.join(base, normalized))
        try:
            if os.path.commonpath([base, target]) == base and os.path.isdir(target):
                return target
        except ValueError:
            pass

    return base


def list_vault_names() -> List[Dict[str, str]]:
    """Return the vault options exposed to the frontend."""
    global vault_names_cache
    with cache_lock:
        if vault_names_cache is not None:
            return [dict(option) for option in vault_names_cache]

    options = build_vault_options()
    with cache_lock:
        vault_names_cache = [dict(option) for option in options]
    return options


def get_active_vault(request: Request) -> str:
    return resolve_vault_root(request)

def secure_path(vault_path: str, user_path: str) -> str:
    base = os.path.realpath(vault_path)
    normalized = normalize_rel_path(user_path)
    if normalized.startswith("../") or normalized == ".." or os.path.isabs(user_path or ""):
        raise HTTPException(status_code=403, detail="Path traversal detected")
    target = os.path.realpath(os.path.join(base, normalized))
    try:
        if os.path.commonpath([base, target]) != base:
            raise HTTPException(status_code=403, detail="Path traversal detected")
    except ValueError:
        raise HTTPException(status_code=403, detail="Path traversal detected")
    return target


def normalize_rel_path(path: str) -> str:
    path = (path or "").replace("\\", "/").strip()
    path = path.lstrip("/")
    path = os.path.normpath(path)
    if path in (".", ""):
        return ""
    return path.replace("\\", "/")


def _get_vault_base_path() -> str:
    return os.path.realpath(os.environ.get("MDVR_VAULT_PATH", os.environ.get("VAULT_PATH", "/vault")))


def _parse_vault_entries(raw: str) -> List[Tuple[str, str]]:
    entries: List[Tuple[str, str]] = []
    for chunk in re.split(r"[\n,]+", raw or ""):
        item = chunk.strip()
        if not item:
            continue
        label = ""
        path = item
        if "=" in item:
            left, right = item.split("=", 1)
            if left.strip() and right.strip():
                label = left.strip()
                path = right.strip()
        entries.append((label, path))
    return entries


def build_vault_options() -> List[Dict[str, str]]:
    global vault_options_cache
    with cache_lock:
        if vault_options_cache is not None:
            return [dict(option) for option in vault_options_cache]

    config = load_mdvr_config()
    configured_vaults = config.get("vaults") if isinstance(config, dict) else None
    if isinstance(configured_vaults, list) and configured_vaults:
        options = [
            {
                "value": str(vault["id"]),
                "id": str(vault["id"]),
                "label": str(vault.get("name") or vault["id"]),
                "name": str(vault.get("name") or vault["id"]),
                "description": str(vault.get("description") or ""),
                "path": str(vault["path"]),
                "mode": str(vault.get("mode", "")),
                "source": "configured",
                "available": os.path.isdir(str(vault["path"])),
            }
            for vault in configured_vaults
        ]
        with cache_lock:
            vault_options_cache = [dict(option) for option in options]
        return options

    base = _get_vault_base_path()
    options: List[Dict[str, str]] = [{
        "value": "/",
        "id": "/",
        "label": os.path.basename(base) or "Vault",
        "name": os.path.basename(base) or "Vault",
        "description": "",
        "path": base,
        "mode": "",
        "source": "local",
        "available": os.path.isdir(base),
    }]
    seen_values = {"/"}
    seen_paths = {base}

    # Default mode: every visible top-level folder under the base path is a vault.
    try:
        if os.path.isdir(base):
            for item in sorted(os.listdir(base)):
                full_item = os.path.join(base, item)
                if os.path.isdir(full_item) and is_visible_dir(item):
                    resolved = os.path.realpath(full_item)
                    if resolved in seen_paths:
                        continue
                    options.append({
                        "value": item,
                        "id": item,
                        "label": item,
                        "name": item,
                        "description": "",
                        "path": resolved,
                        "mode": "",
                        "source": "local",
                        "available": os.path.isdir(resolved),
                    })
                    seen_values.add(item)
                    seen_paths.add(resolved)
    except Exception:
        pass

    # Optional explicit vault list for extra folders mounted elsewhere.
    raw_extra = os.environ.get("MDVR_VAULTS", os.environ.get("VAULTS", "")).strip()
    for index, (label, raw_path) in enumerate(_parse_vault_entries(raw_extra), start=1):
        expanded = os.path.expanduser(raw_path)
        if not os.path.isabs(expanded):
            expanded = os.path.join(base, expanded)
        resolved = os.path.realpath(expanded)
        if not os.path.isdir(resolved) or resolved in seen_paths:
            continue
        value = resolved
        if value in seen_values:
            value = f"vault-{index}"
        options.append({
            "value": value,
            "id": value,
            "label": label or os.path.basename(resolved) or value,
            "name": label or os.path.basename(resolved) or value,
            "description": "",
            "path": resolved,
            "mode": "",
            "source": "local",
            "available": os.path.isdir(resolved),
        })
        seen_values.add(value)
        seen_paths.add(resolved)

    with cache_lock:
        vault_options_cache = [dict(option) for option in options]
    return options


def is_visible_note_name(name: str) -> bool:
    return is_markdown_file(name) or is_excalidraw_file(name)


def iter_visible_notes(root_path: str):
    for root, dirs, files in os.walk(root_path):
        dirs[:] = [d for d in dirs if is_visible_dir(d)]
        for file in files:
            if is_visible_note_name(file):
                yield os.path.join(root, file)


def read_text_file(path: str) -> str:
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        return f.read()


def extract_frontmatter(text: str) -> Tuple[str, str]:
    if not text.startswith('---\n'):
        return "", text
    lines = text.splitlines()
    end = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == '---':
            end = idx
            break
    if end is None:
        return "", text
    frontmatter = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1 :])
    return frontmatter, body


def normalize_tag(raw: str) -> str:
    tag = raw.strip().strip('"\'').strip()
    if tag.startswith("#"):
        tag = tag[1:]
    tag = tag.strip().strip(",;")
    return tag


def parse_tags_from_frontmatter(frontmatter: str) -> List[str]:
    tags: List[str] = []
    if not frontmatter:
        return tags
    lines = frontmatter.splitlines()
    collecting = False
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith('tags:'):
            collecting = True
            inline = stripped[len('tags:'):].strip()
            if inline.startswith('[') and inline.endswith(']'):
                inline = inline[1:-1].strip()
                if inline:
                    for part in inline.split(','):
                        cleaned = normalize_tag(part)
                        if cleaned:
                            tags.append(cleaned)
                collecting = False
            elif inline:
                for part in re.split(r'[\s,]+', inline):
                    cleaned = normalize_tag(part)
                    if cleaned:
                        tags.append(cleaned)
                collecting = False
            continue
        if collecting:
            if stripped.startswith('- '):
                cleaned = normalize_tag(stripped[2:])
                if cleaned:
                    tags.append(cleaned)
            elif line.startswith(' ') or line.startswith('\t'):
                cleaned = normalize_tag(stripped)
                if cleaned and cleaned != 'tags:':
                    tags.append(cleaned)
            else:
                collecting = False
    return sorted({tag for tag in tags if tag})


def parse_tags_from_body(text: str) -> List[str]:
    tags: List[str] = []
    lines = text.splitlines()
    in_code_block = False
    collecting_tags_block = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code_block = not in_code_block
            collecting_tags_block = False
            continue
        if in_code_block:
            continue

        inline_heading = re.match(r'^(?:#{1,6}\s*)?tags\s*[:\-]\s*(.+)$', stripped, re.IGNORECASE)
        if inline_heading:
            for part in re.split(r'[\s,]+', inline_heading.group(1)):
                cleaned = normalize_tag(part)
                if cleaned:
                    tags.append(cleaned)
            collecting_tags_block = False
            continue

        if re.match(r'^(?:#{1,6}\s*)?tags:?$', stripped, re.IGNORECASE):
            collecting_tags_block = True
            continue

        if collecting_tags_block:
            list_match = re.match(r'^[-*+]\s+(.+)$', stripped)
            if list_match:
                cleaned = normalize_tag(list_match.group(1))
                if cleaned:
                    tags.append(cleaned)
                continue
            if not stripped:
                collecting_tags_block = False
                continue
            collecting_tags_block = False

        for match in re.finditer(r'(?<![\w/])#([A-Za-z0-9][A-Za-z0-9_/-]*)', line):
            cleaned = normalize_tag(match.group(1))
            if cleaned:
                tags.append(cleaned)

    return sorted({tag for tag in tags if tag})


def extract_wikilinks(text: str) -> List[str]:
    links = []
    for match in re.finditer(r'\[\[([^\]]+)\]\]', text):
        raw = match.group(1)
        target = raw.split('|', 1)[0].split('#', 1)[0].strip()
        if target:
            links.append(target)
    return links


def scan_vault_index(active_vault: str) -> Tuple[List[Dict], Dict[str, Dict], Dict[str, List[Dict]], Dict[str, List[Dict]]]:
    with cache_lock:
        cached = vault_index_cache.get(active_vault)
    if cached is not None:
        return cached

    files: List[Dict] = []
    by_path: Dict[str, Dict] = {}
    by_stem: Dict[str, List[Dict]] = {}
    tag_index: Dict[str, List[Dict]] = {}

    for full_path in iter_visible_notes(active_vault):
        rel_path = os.path.relpath(full_path, active_vault).replace('\\', '/')
        try:
            content = read_text_file(full_path)
        except Exception:
            continue
        frontmatter, body = extract_frontmatter(content)
        tags = sorted(set(parse_tags_from_frontmatter(frontmatter) + parse_tags_from_body(body)))
        links = extract_wikilinks(content)
        entry = {
            'name': os.path.basename(rel_path),
            'path': rel_path,
            'stem': os.path.splitext(os.path.basename(rel_path))[0],
            'tags': tags,
            'links': links,
        }
        files.append(entry)
        by_path[rel_path.lower()] = entry
        by_stem.setdefault(entry['stem'].lower(), []).append(entry)
        for tag in tags:
            tag_index.setdefault(tag.lower(), []).append(entry)

    result = (files, by_path, by_stem, tag_index)
    with cache_lock:
        vault_index_cache[active_vault] = result
    return result


def resolve_wikilink_target(target: str, by_path: Dict[str, Dict], by_stem: Dict[str, List[Dict]]) -> Optional[str]:
    normalized = normalize_rel_path(target)
    if not normalized:
        return None

    candidates = [normalized]
    if not normalized.lower().endswith(('.md', '.excalidraw')):
        candidates.extend([f'{normalized}.md', f'{normalized}.excalidraw'])
    for candidate in candidates:
        hit = by_path.get(candidate.lower())
        if hit:
            return hit['path']

    stem = os.path.splitext(os.path.basename(normalized))[0].lower()
    if stem in by_stem and len(by_stem[stem]) == 1:
        return by_stem[stem][0]['path']
    return None


def build_backlinks(target_path: str, by_path: Dict[str, Dict], by_stem: Dict[str, List[Dict]]) -> List[Dict]:
    target_lower = target_path.lower()
    target_stem = os.path.splitext(os.path.basename(target_path))[0].lower()
    backlinks: List[Dict] = []

    for rel_lower, entry in by_path.items():
        # direct reference by path or by filename stem
        resolved = False
        for link in entry.get('links', []):
            resolved_path = resolve_wikilink_target(link, by_path, by_stem)
            if resolved_path and resolved_path.lower() == target_lower:
                backlinks.append(entry)
                resolved = True
                break
            if not resolved_path and os.path.splitext(os.path.basename(normalize_rel_path(link)))[0].lower() == target_stem:
                if len(by_stem.get(target_stem, [])) == 1:
                    backlinks.append(entry)
                    resolved = True
                break
        if resolved:
            continue
    return backlinks


def build_note_metadata(active_vault: str, path: str, content: str) -> Tuple[List[str], List[Dict], List[Dict]]:
    """Return note tags plus resolved outbound and inbound wiki links."""
    frontmatter, body = extract_frontmatter(content)
    tags = sorted(set(parse_tags_from_frontmatter(frontmatter) + parse_tags_from_body(body)))
    links = extract_wikilinks(content)
    _, by_path, by_stem, _ = scan_vault_index(active_vault)
    backlinks = build_backlinks(path, by_path, by_stem)
    resolved_links = [
        {"label": link, "path": resolve_wikilink_target(link, by_path, by_stem) or link}
        for link in links
    ]
    return tags, resolved_links, backlinks


def list_folder_children(active_vault: str, relative_path: str) -> List[Dict]:
    key = (active_vault, relative_path)
    with cache_lock:
        cached = folder_children_cache.get(key)
    if cached is not None:
        return cached

    folder = secure_path(active_vault, relative_path)
    if not os.path.isdir(folder):
        raise HTTPException(status_code=404, detail='Folder not found')
    children: List[Dict] = []
    try:
        names = sorted(os.listdir(folder), key=lambda name: (not os.path.isdir(os.path.join(folder, name)), name.lower()))
    except OSError:
        return children
    for name in names:
        if is_hidden_name(name):
            continue
        full_path = os.path.join(folder, name)
        rel_path = os.path.relpath(full_path, active_vault).replace("\\", "/")
        if os.path.isdir(full_path):
            children.append({
                "name": name,
                "path": rel_path,
                "is_dir": True,
                "children": list_folder_children(active_vault, rel_path),
            })
        elif can_read_file(active_vault, rel_path):
            tags: List[str] = []
            if is_text_like_file(rel_path):
                try:
                    frontmatter, body = extract_frontmatter(read_text_file(full_path))
                    tags = sorted(set(parse_tags_from_frontmatter(frontmatter) + parse_tags_from_body(body)))
                except Exception:
                    tags = []
            children.append({
                "name": name,
                "path": rel_path,
                "is_dir": False,
                "children": None,
                "mtime": os.path.getmtime(full_path),
                "tags": tags,
            })
    with cache_lock:
        folder_children_cache[key] = children
    return children


def get_mdvr_config_file() -> str:
    return os.path.realpath(os.environ.get('MDVR_CONFIG_FILE', '/app/mdvr.yaml'))


def load_mdvr_config() -> Dict:
    global mdvr_config_cache
    config_path = get_mdvr_config_file()
    try:
        mtime = os.path.getmtime(config_path)
    except OSError:
        mtime = -1.0

    with cache_lock:
        cached = mdvr_config_cache
        if cached and cached[0] == config_path and cached[1] == mtime:
            return cached[2]

    data: Dict = {}
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as handle:
                loaded = yaml.safe_load(handle)
                if not isinstance(loaded, dict):
                    raise ValueError("MDVR config root must be a mapping")
                data = validate_mdvr_config(loaded)
        except HTTPException:
            raise
        except ValueError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Unable to load MDVR config {config_path}: {exc}") from exc

    with cache_lock:
        mdvr_config_cache = (config_path, mtime, data)
    return data


def _unknown_policy(config: Dict[str, Any]) -> str:
    server = config.get("server") if isinstance(config.get("server"), dict) else {}
    policy = str(server.get("unknown_keys", "fail")).strip().lower()
    return policy if policy in {"fail", "warn"} else "fail"


def _check_keys(label: str, data: Any, allowed: Set[str], policy: str) -> None:
    if not isinstance(data, dict):
        return
    unknown = sorted(set(data) - allowed)
    if not unknown:
        return
    message = f"Unknown MDVR config key(s) in {label}: {', '.join(unknown)}"
    if policy == "warn":
        logger.warning(message)
        return
    raise ValueError(message)


def _normalize_permission_formats(value) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    normalized = []
    for item in value:
        if item is None:
            continue
        text = str(item).strip().lower()
        if text == "*":
            normalized.append(text)
        elif text.startswith(".") and len(text) > 1:
            normalized.append(text)
        elif text:
            raise ValueError(f"File extension '{text}' must start with '.'")
    return normalized


def _merge_permissions(base: Dict, override: Optional[Dict]) -> Dict:
    merged = dict(base)
    override = override or {}
    for key in ('read', 'edit', 'new_files', 'rename', 'delete', 'hide_read'):
        if key in override:
            merged[key] = bool(override.get(key))
    for key in ('files_format_read', 'files_format_edit', 'files_format_new'):
        if key in override:
            merged[key] = _normalize_permission_formats(override.get(key))
    return merged


def _validate_permission_subsets(perms: Dict[str, Any], label: str) -> None:
    read_formats = set(perms.get("files_format_read", []))
    for key in ("files_format_edit", "files_format_new"):
        formats = set(perms.get(key, []))
        if "*" in read_formats:
            continue
        if "*" in formats or not formats.issubset(read_formats):
            raise ValueError(f"{label}.{key} must be a subset of files_format_read")


def _auth_enabled(config: Dict[str, Any]) -> bool:
    env_enabled = os.environ.get("MDVR_AUTH_ENABLED")
    if env_enabled is not None and env_enabled.strip() != "":
        return env_enabled.strip().lower() in {"1", "true", "yes", "on"}

    server = config.get("server") if isinstance(config.get("server"), dict) else {}
    auth = server.get("auth") if isinstance(server.get("auth"), dict) else None
    if auth is None:
        auth = config.get("auth") if isinstance(config.get("auth"), dict) else {}
    return str(auth.get("enabled", False)).strip().lower() in {"1", "true", "yes", "on"}


def _has_write_permissions(config: Dict[str, Any]) -> bool:
    for vault in config.get("vaults", []):
        perms = vault.get("resolved_permissions", {})
        if any(bool(perms.get(key)) for key in ("edit", "new_files", "rename", "delete")):
            return True
    return False


def validate_mdvr_config(config: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(config, dict):
        raise ValueError("MDVR config root must be a mapping")

    policy = _unknown_policy(config)
    _check_keys("root", config, CONFIG_TOP_KEYS, policy)

    app_config = config.get("app") if isinstance(config.get("app"), dict) else {}
    server_config = config.get("server") if isinstance(config.get("server"), dict) else {}
    defaults_config = config.get("defaults") if isinstance(config.get("defaults"), dict) else {}
    _check_keys("app", app_config, APP_KEYS, policy)
    _check_keys("server", server_config, SERVER_KEYS, policy)
    _check_keys("defaults", defaults_config, DEFAULTS_KEYS, policy)
    if isinstance(server_config.get("auth"), dict):
        _check_keys("server.auth", server_config["auth"], AUTH_KEYS, policy)
    if isinstance(config.get("auth"), dict):
        _check_keys("auth", config["auth"], AUTH_KEYS, policy)

    default_mode = str(defaults_config.get("mode", "read-only")).strip()
    if default_mode not in MODE_PERMISSIONS:
        raise ValueError(f"Unknown default vault mode: {default_mode}")
    default_permissions = _merge_permissions(MODE_PERMISSIONS[default_mode], defaults_config.get("permissions"))
    _check_keys("defaults.permissions", defaults_config.get("permissions", {}), PERMISSION_KEYS, policy)
    _validate_permission_subsets(default_permissions, "defaults.permissions")

    raw_vaults = config.get("vaults", [])
    if not isinstance(raw_vaults, list) or not raw_vaults:
        raise ValueError("MDVR config requires at least one vault")

    seen_ids: Set[str] = set()
    seen_paths: Set[str] = set()
    normalized_vaults: List[Dict[str, Any]] = []
    for index, vault in enumerate(raw_vaults):
        if not isinstance(vault, dict):
            raise ValueError(f"vaults[{index}] must be a mapping")
        _check_keys(f"vaults[{index}]", vault, VAULT_KEYS, policy)
        vault_id = str(vault.get("id", "")).strip()
        if not VAULT_ID_RE.match(vault_id):
            raise ValueError(f"vaults[{index}].id must be URL-safe and start with a letter or number")
        if vault_id in seen_ids:
            raise ValueError(f"Duplicate vault id: {vault_id}")
        raw_path = str(vault.get("path", "")).strip()
        if not os.path.isabs(raw_path):
            raise ValueError(f"vaults[{index}].path must be an absolute container path")
        real_path = os.path.realpath(os.path.expanduser(raw_path))
        if real_path in seen_paths:
            raise ValueError(f"Duplicate vault path: {raw_path}")
        mode = str(vault.get("mode", default_mode)).strip()
        if mode not in MODE_PERMISSIONS:
            raise ValueError(f"Unknown mode for vault {vault_id}: {mode}")
        _check_keys(f"vaults[{index}].permissions", vault.get("permissions", {}), PERMISSION_KEYS, policy)
        permissions = dict(default_permissions)
        for key in ("read", "edit", "new_files", "rename", "delete", "hide_read"):
            permissions[key] = MODE_PERMISSIONS[mode][key]
        permissions = _merge_permissions(permissions, vault.get("permissions"))
        _validate_permission_subsets(permissions, f"vaults[{index}].permissions")
        if permissions.get("delete"):
            logger.warning("MDVR vault %s has delete enabled; deletes are soft-delete moves to .mdvr-trash.", vault_id)
        normalized = dict(vault)
        normalized["id"] = vault_id
        normalized["name"] = str(vault.get("name") or vault_id)
        normalized["description"] = str(vault.get("description") or "")
        normalized["path"] = real_path
        normalized["mode"] = mode
        normalized["resolved_permissions"] = permissions
        normalized_vaults.append(normalized)
        seen_ids.add(vault_id)
        seen_paths.add(real_path)

    normalized_config = dict(config)
    normalized_config["app"] = {"name": app_config.get("name", "MDVR"), "description": app_config.get("description", "")}
    normalized_config["server"] = server_config
    normalized_config["defaults"] = {"mode": default_mode, "permissions": default_permissions}
    normalized_config["vaults"] = normalized_vaults

    if not _auth_enabled(normalized_config):
        logger.warning("MDVR authentication is disabled.")
        if _has_write_permissions(normalized_config):
            write_policy = str(server_config.get("write_without_auth", "fail")).strip().lower()
            message = "MDVR config enables write permissions while authentication is disabled."
            if write_policy == "warn":
                logger.warning(message)
            elif write_policy != "allow":
                raise ValueError(message)
    return normalized_config


def _resolve_config_vault_entry(active_vault: str, config: Dict) -> Optional[Dict]:
    vaults = config.get('vaults') if isinstance(config, dict) else None
    if not isinstance(vaults, list):
        return None
    active_real = os.path.realpath(active_vault)
    active_name = os.path.basename(os.path.normpath(active_vault)).lower()
    for entry in vaults:
        if not isinstance(entry, dict):
            continue
        entry_path = entry.get('path')
        entry_id = str(entry.get('id', '') or '').strip()
        entry_name = str(entry.get('name', '') or '').strip().lower()
        if active_vault == entry_id:
            return entry
        if entry_path and os.path.realpath(os.path.expanduser(str(entry_path))) == active_real:
            return entry
        if entry_name and entry_name == active_name and not entry_path:
            return entry
    return None


def get_vault_permissions(active_vault: str) -> Dict:
    config = load_mdvr_config()
    default_config = config.get("defaults", {}) if isinstance(config, dict) else {}
    permissions = dict(default_config.get("permissions", MODE_PERMISSIONS["read-only"]))
    vault_entry = _resolve_config_vault_entry(active_vault, config)
    if vault_entry:
        permissions = dict(vault_entry.get("resolved_permissions", permissions))
    return permissions


def _matches_format(path: str, allowed_formats: List[str]) -> bool:
    if not allowed_formats:
        return False
    lower_path = (path or '').lower()
    ext = os.path.splitext(lower_path)[1]
    if '*' in allowed_formats:
        return True
    return ext in set(allowed_formats)


def can_read_file(active_vault: str, path: str) -> bool:
    perms = get_vault_permissions(active_vault)
    if not bool(perms.get('read', True)) or perms.get('hide_read'):
        return False
    return _matches_format(path, perms.get('files_format_read', []))


def ensure_read_allowed(active_vault: str) -> None:
    perms = get_vault_permissions(active_vault)
    if not bool(perms.get("read", True)) or bool(perms.get("hide_read")):
        raise HTTPException(status_code=403, detail="Read is not allowed for this vault")


def can_edit_file(active_vault: str, path: str) -> bool:
    perms = get_vault_permissions(active_vault)
    return bool(perms.get('edit')) and _matches_format(path, perms.get('files_format_edit', []))


def can_create_file(active_vault: str, path: str) -> bool:
    perms = get_vault_permissions(active_vault)
    return bool(perms.get('new_files')) and _matches_format(path, perms.get('files_format_new', []))


def can_rename_file(active_vault: str, path: str) -> bool:
    perms = get_vault_permissions(active_vault)
    return bool(perms.get('rename'))


def can_delete_file(active_vault: str, path: str) -> bool:
    perms = get_vault_permissions(active_vault)
    return bool(perms.get('delete'))


def _active_vault_entry(request: Request) -> Optional[Dict[str, Any]]:
    active = get_active_vault(request)
    return _resolve_config_vault_entry(active, load_mdvr_config())


def _public_permissions(active_vault: str) -> Dict[str, Any]:
    perms = get_vault_permissions(active_vault)
    return {
        "read": bool(perms.get("read", True)) and not bool(perms.get("hide_read")),
        "edit": bool(perms.get("edit")),
        "new_files": bool(perms.get("new_files")),
        "rename": bool(perms.get("rename")),
        "delete": bool(perms.get("delete")),
        "files_format_read": list(perms.get("files_format_read", [])),
        "files_format_edit": list(perms.get("files_format_edit", [])),
        "files_format_new": list(perms.get("files_format_new", [])),
    }


def _ensure_parent_dir_safe(active_vault: str, target: str) -> None:
    parent = os.path.dirname(target)
    base = os.path.realpath(active_vault)
    real_parent = os.path.realpath(parent)
    try:
        if os.path.commonpath([base, real_parent]) != base:
            raise HTTPException(status_code=403, detail="Path traversal detected")
    except ValueError:
        raise HTTPException(status_code=403, detail="Path traversal detected")
    os.makedirs(real_parent, exist_ok=True)


ASSET_EXTENSIONS = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg", ".ico", ".pdf",
}


def sanitize_asset_filename(filename: str, content_type: str = "") -> str:
    raw = os.path.basename((filename or "").replace("\\", "/")).strip()
    raw = re.sub(r"[^A-Za-z0-9._ -]+", "-", raw)
    raw = re.sub(r"\s+", " ", raw).strip(" .")
    if not raw:
        raw = "document.pdf" if content_type == "application/pdf" else "image.png"
    stem, ext = os.path.splitext(raw)
    ext = ext.lower()
    if not ext:
        if content_type == "application/pdf":
            ext = ".pdf"
        elif content_type == "image/jpeg":
            ext = ".jpg"
        elif content_type.startswith("image/"):
            ext = f".{content_type.split('/', 1)[1].split('+', 1)[0].lower()}"
        else:
            ext = ".bin"
    if ext not in ASSET_EXTENSIONS:
        raise HTTPException(status_code=403, detail="Only image and PDF assets can be uploaded")
    stem = stem.strip(" .") or ("document" if ext == ".pdf" else "image")
    return f"{stem}{ext}"


def attachment_dir_for(current_path: str) -> str:
    normalized = normalize_rel_path(current_path)
    folder = os.path.dirname(normalized)
    return normalize_rel_path(os.path.join(folder, "_attachments")) if folder else "_attachments"


def unique_asset_path(active_vault: str, folder: str, filename: str) -> Tuple[str, str]:
    stem, ext = os.path.splitext(filename)
    for index in range(0, 1000):
        candidate_name = filename if index == 0 else f"{stem}-{index}{ext}"
        rel_path = normalize_rel_path(os.path.join(folder, candidate_name))
        full_path = secure_path(active_vault, rel_path)
        if not os.path.exists(full_path):
            return rel_path, full_path
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rel_path = normalize_rel_path(os.path.join(folder, f"{stem}-{stamp}{ext}"))
    return rel_path, secure_path(active_vault, rel_path)


def atomic_write_text(path: str, content: str) -> None:
    directory = os.path.dirname(path)
    fd, tmp_path = tempfile.mkstemp(prefix=".mdvr-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def soft_delete_path(active_vault: str, path: str, target: str) -> str:
    trash_root = secure_path(active_vault, ".mdvr-trash")
    os.makedirs(trash_root, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    rel = normalize_rel_path(path)
    destination = os.path.realpath(os.path.join(trash_root, stamp, rel))
    try:
        if os.path.commonpath([trash_root, destination]) != trash_root:
            raise HTTPException(status_code=403, detail="Path traversal detected")
    except ValueError:
        raise HTTPException(status_code=403, detail="Path traversal detected")
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.move(target, destination)
    return os.path.relpath(destination, active_vault).replace("\\", "/")


@app.get("/api/config")
def api_config(request: Request):
    active = get_active_vault(request)
    entry = _resolve_config_vault_entry(active, load_mdvr_config()) or {}
    return {
        "app": load_mdvr_config().get("app", {"name": "MDVR"}),
        "vault": {
            "id": entry.get("id", request.headers.get("x-vault-path", "") or "/"),
            "name": entry.get("name", os.path.basename(active) or "Vault"),
            "description": entry.get("description", ""),
            "mode": entry.get("mode", "read-only"),
        },
        "permissions": _public_permissions(active),
    }


@app.get("/api/vaults")
def api_vaults():
    options = list_vault_names()
    return {
        "vaults": [
            {
                "id": option["value"],
                "name": option.get("name") or option.get("label") or option["value"],
                "description": option.get("description", ""),
                "path": option.get("path", ""),
                "mode": option.get("mode", ""),
                "source": option.get("source", "configured"),
                "available": bool(option.get("available", True)),
            }
            for option in options
        ]
    }


@app.get("/api/vault-name")
def api_vault_name(request: Request):
    active = get_active_vault(request)
    entry = _resolve_config_vault_entry(active, load_mdvr_config()) or {}
    return {
        "name": entry.get("name", os.path.basename(active) or "Vault"),
        "description": entry.get("description", ""),
        "permissions": _public_permissions(active),
    }


@app.get("/api/files")
def api_files(request: Request):
    active = get_active_vault(request)
    ensure_read_allowed(active)
    return {"files": list_folder_children(active, "")}


@app.get("/api/recent")
def api_recent(request: Request):
    active = get_active_vault(request)
    ensure_read_allowed(active)
    cached = recent_files_cache.get(active)
    if cached is not None:
        return {"files": cached}
    files: List[Dict[str, Any]] = []
    for root, dirs, names in os.walk(active):
        dirs[:] = [name for name in dirs if is_visible_dir(name)]
        for name in names:
            rel_path = os.path.relpath(os.path.join(root, name), active).replace("\\", "/")
            if not can_read_file(active, rel_path):
                continue
            full_path = secure_path(active, rel_path)
            try:
                stat = os.stat(full_path)
                excerpt = ""
                tags: List[str] = []
                if is_text_like_file(rel_path):
                    content = read_text_file(full_path)
                    excerpt = content[:240].replace("\n", " ")
                    frontmatter, body = extract_frontmatter(content)
                    tags = sorted(set(parse_tags_from_frontmatter(frontmatter) + parse_tags_from_body(body)))
                files.append({"name": name, "path": rel_path, "mtime": stat.st_mtime, "excerpt": excerpt, "tags": tags})
            except OSError:
                continue
    files.sort(key=lambda item: item["mtime"], reverse=True)
    files = files[:50]
    recent_files_cache[active] = files
    return {"files": files}


@app.get("/api/file")
def api_get_file(path: str, request: Request):
    active = get_active_vault(request)
    if not can_read_file(active, path):
        raise HTTPException(status_code=403, detail="Read is not allowed for this file type")
    full_path = secure_path(active, path)
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_text_like_file(path):
        media_type = mimetypes.guess_type(full_path)[0] or "application/octet-stream"
        return FileResponse(full_path, media_type=media_type)
    content = read_text_file(full_path)
    stat = os.stat(full_path)
    return {
        "path": normalize_rel_path(path),
        "content": content,
        "mtime": stat.st_mtime,
        "kind": get_file_kind(path),
        "permissions": _public_permissions(active),
        "metadata": build_note_metadata(active, normalize_rel_path(path), content) if is_visible_note_name(path) else None,
    }


@app.put("/api/file")
def api_put_file(payload: FileWriteRequest, request: Request):
    active = get_active_vault(request)
    if not can_edit_file(active, payload.path):
        raise HTTPException(status_code=403, detail="Edit is not allowed for this file type")
    full_path = secure_path(active, payload.path)
    if not os.path.isfile(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    if not is_text_like_file(payload.path):
        raise HTTPException(status_code=403, detail="Only text-like files can be edited")
    atomic_write_text(full_path, payload.content)
    invalidate_vault_caches()
    return {"ok": True}


@app.post("/api/files")
def api_create_file(payload: FileWriteRequest, request: Request):
    active = get_active_vault(request)
    if not can_create_file(active, payload.path):
        raise HTTPException(status_code=403, detail="Create is not allowed for this file type")
    full_path = secure_path(active, payload.path)
    if os.path.exists(full_path):
        raise HTTPException(status_code=409, detail="File already exists")
    if not is_text_like_file(payload.path):
        raise HTTPException(status_code=403, detail="Only text-like files can be created")
    _ensure_parent_dir_safe(active, full_path)
    atomic_write_text(full_path, payload.content)
    invalidate_vault_caches()
    return {"ok": True, "path": normalize_rel_path(payload.path)}


@app.post("/api/assets")
def api_upload_asset(payload: AssetUploadRequest, request: Request):
    active = get_active_vault(request)
    perms = get_vault_permissions(active)
    if not bool(perms.get("new_files")):
        raise HTTPException(status_code=403, detail="Asset upload is not allowed")

    filename = sanitize_asset_filename(payload.filename, payload.content_type)
    folder = attachment_dir_for(payload.current_path)
    rel_path, full_path = unique_asset_path(active, folder, filename)
    if not can_read_file(active, rel_path):
        raise HTTPException(status_code=403, detail="Asset file type is not allowed")

    try:
        content = base64.b64decode(payload.content_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Invalid base64 asset content")
    if not content:
        raise HTTPException(status_code=400, detail="Asset is empty")
    if len(content) > MAX_CONTENT_SIZE:
        raise HTTPException(status_code=413, detail="Asset is too large")

    _ensure_parent_dir_safe(active, full_path)
    with open(full_path, "xb") as handle:
        handle.write(content)
    invalidate_vault_caches()
    kind = "pdf" if rel_path.lower().endswith(".pdf") else "image"
    return {"ok": True, "path": rel_path, "name": os.path.basename(rel_path), "kind": kind}


@app.put("/api/rename")
def api_rename_file(payload: RenameRequest, request: Request):
    active = get_active_vault(request)
    if not can_rename_file(active, payload.old_path):
        raise HTTPException(status_code=403, detail="Rename is not allowed")
    if not can_read_file(active, payload.old_path):
        raise HTTPException(status_code=403, detail="Source file type is not allowed")
    if not can_create_file(active, payload.new_path) and not can_edit_file(active, payload.new_path):
        raise HTTPException(status_code=403, detail="Destination file type is not allowed")
    old_full = secure_path(active, payload.old_path)
    new_full = secure_path(active, payload.new_path)
    if not os.path.exists(old_full):
        raise HTTPException(status_code=404, detail="Source not found")
    if os.path.exists(new_full):
        raise HTTPException(status_code=409, detail="Destination already exists")
    _ensure_parent_dir_safe(active, new_full)
    os.replace(old_full, new_full)
    invalidate_vault_caches()
    return {"ok": True, "path": normalize_rel_path(payload.new_path)}


@app.delete("/api/file")
def api_delete_file(path: str, request: Request):
    active = get_active_vault(request)
    if not can_delete_file(active, path):
        raise HTTPException(status_code=403, detail="Delete is not allowed")
    full_path = secure_path(active, path)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="File not found")
    deleted_to = soft_delete_path(active, path, full_path)
    invalidate_vault_caches()
    return {"ok": True, "deleted_to": deleted_to}
