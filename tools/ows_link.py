#!/usr/bin/env python3
"""Build Telegram-friendly Obsidian Web Reader links.

Examples:
  python tools/ows_link.py "Research/note.md"
  python tools/ows_link.py --label "Open note" Research/note.md
  python tools/ows_link.py --raw --vault Work Research/note.md
  python tools/ows_link.py --style hash "Research/note.md"

By default the script emits a clickable Markdown link that points at the
slash-preserving path-style OWS URL used in Telegram chats.
"""

from __future__ import annotations

import argparse
from urllib.parse import quote

DEFAULT_BASE_URL = "http://homeframe:3080"


def normalize_path(path: str) -> str:
    path = path.strip().strip('"').strip("'")
    path = path.replace("\\", "/")
    path = path.lstrip("/")
    parts = [part for part in path.split("/") if part not in {"", "."}]
    return "/".join(parts)


def build_path_url(path: str, vault: str | None = None, base_url: str = DEFAULT_BASE_URL) -> str:
    safe_path = "/".join(quote(part, safe="") for part in path.split("/") if part)
    url = f"{base_url}/obsidian/{safe_path}"
    if vault:
        url = f"{url}?vault={quote(vault, safe='')}"
    return url


def build_query_url(path: str, vault: str | None = None, base_url: str = DEFAULT_BASE_URL) -> str:
    params = []
    if vault:
        params.append(f"vault={quote(vault, safe='')}")
    params.append(f"path={quote(path, safe='')}")
    return f"{base_url}/?{'&'.join(params)}"


def build_hash_url(path: str, vault: str | None = None, base_url: str = DEFAULT_BASE_URL) -> str:
    parts = [f"path={quote(path, safe='')}"]
    if vault:
        parts.insert(0, f"vault={quote(vault, safe='')}")
    return f"{base_url}/#{'&'.join(parts)}"


def build_url(
    path: str,
    vault: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
    style: str = "path",
) -> str:
    if style == "hash":
        return build_hash_url(path=path, vault=vault, base_url=base_url)
    if style == "query":
        return build_query_url(path=path, vault=vault, base_url=base_url)
    return build_path_url(path=path, vault=vault, base_url=base_url)


def build_markdown_link(
    path: str,
    label: str | None = None,
    vault: str | None = None,
    base_url: str = DEFAULT_BASE_URL,
    style: str = "path",
) -> str:
    url = build_url(path=path, vault=vault, base_url=base_url, style=style)
    link_label = label or path
    return f"[{link_label}]({url})"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert note paths into OWS links")
    parser.add_argument("path", help="Vault-relative note path, e.g. Research/note.md")
    parser.add_argument("--vault", default="", help="Optional vault name for multi-vault setups")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Base OWS URL (default: http://homeframe:3080)")
    parser.add_argument("--label", default="", help="Markdown label to show instead of the raw path")
    parser.add_argument("--style", choices=("path", "query", "hash"), default="path", help="URL style to generate")
    parser.add_argument("--raw", action="store_true", help="Print the raw URL instead of a Markdown link")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    path = normalize_path(args.path)
    vault = normalize_path(args.vault) if args.vault else ""

    if not path:
        raise SystemExit("error: path is empty after normalization")

    if args.raw:
        print(build_url(path=path, vault=vault or None, base_url=args.base_url, style=args.style))
    else:
        print(build_markdown_link(path=path, label=args.label or None, vault=vault or None, base_url=args.base_url, style=args.style))


if __name__ == "__main__":
    main()
