from __future__ import annotations

import re
import base64
import asyncio
from pathlib import Path
from typing import Any, cast

import pytest
import yaml
from starlette.responses import Response

import main
from tools.mdvr_link import build_path_url
from tools.mdvr_nginx import render_nginx_config


class FakeRequest:
    def __init__(self, headers: dict[str, str] | None = None, query_params: dict[str, str] | None = None):
        self.headers = headers or {}
        self.query_params = query_params or {}


def test_path_links_keep_spaces_and_underscores_distinct() -> None:
    space_url = build_path_url("file like this.md")
    underscore_url = build_path_url("file_like_this.md")

    assert "%20" in space_url
    assert space_url != underscore_url
    assert underscore_url.endswith("/file_like_this.md")


def test_nginx_config_toggles_basic_auth_block() -> None:
    auth_enabled = render_nginx_config(True, "MDVR", "/run/mdvr.htpasswd")
    auth_disabled = render_nginx_config(False, "MDVR", "/run/mdvr.htpasswd")

    assert 'auth_basic "MDVR";' in auth_enabled
    assert 'auth_basic_user_file /run/mdvr.htpasswd;' in auth_enabled
    assert 'auth_basic' not in auth_disabled
    assert 'X-Frame-Options SAMEORIGIN' in auth_enabled


def test_security_headers_allow_same_origin_pdf_preview() -> None:
    middleware = main.SecurityHeadersMiddleware(app=cast(Any, object()))

    async def call_next(_request: object) -> Response:
        return Response("ok")

    response = asyncio.run(middleware.dispatch(cast(Any, object()), cast(Any, call_next)))

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"


def test_vault_registry_supports_root_subfolders_and_explicit_vaults(tmp_path, monkeypatch) -> None:
    base = tmp_path / "vaults"
    base.mkdir()
    (base / "Alpha").mkdir()
    (base / "Beta").mkdir()

    extra = tmp_path / "external-vault"
    extra.mkdir()

    monkeypatch.setenv("MDVR_CONFIG_FILE", str(tmp_path / "missing-mdvr.yaml"))
    monkeypatch.setenv("MDVR_VAULT_PATH", str(base))
    monkeypatch.setenv("MDVR_VAULTS", f"Archive={extra}")
    main.invalidate_vault_caches()

    options = main.list_vault_names()
    values = {opt["value"] for opt in options}
    labels = {opt["label"] for opt in options}

    assert "/" in values
    assert "Alpha" in values
    assert "Beta" in values
    assert str(extra) in values
    assert "Archive" in labels

    assert main.resolve_vault_root(cast(Any, FakeRequest({"x-vault-path": "Alpha"}))) == str(base / "Alpha")
    assert main.resolve_vault_root(cast(Any, FakeRequest({"x-vault-path": str(extra)}))) == str(extra)
    assert main.resolve_vault_root(cast(Any, FakeRequest({"x-vault-path": ""}))) == str(base)


def test_wikilink_resolution_prefers_exact_path_and_rejects_ambiguous_stems() -> None:
    by_path = {
        "dir/file like this.md": {"path": "dir/file like this.md"},
        "dir/file_like_this.md": {"path": "dir/file_like_this.md"},
    }
    by_stem = {
        "file like this": [by_path["dir/file like this.md"]],
        "file_like_this": [by_path["dir/file_like_this.md"]],
        "file": [
            {"path": "dir/file like this.md"},
            {"path": "dir/file_like_this.md"},
        ],
    }

    assert main.resolve_wikilink_target("dir/file like this.md", by_path, by_stem) == "dir/file like this.md"
    assert main.resolve_wikilink_target("file", by_path, by_stem) is None


def test_tag_parsing_supports_obsidian_and_mdvr_compatibility_formats() -> None:
    frontmatter = """tags: [hot, '#project/demo']
aliases:
  - Roadmap
"""
    body = """Tags
- planning
- #hot

# Roadmap
Inline tags like #research/note should work.
"""

    assert main.parse_tags_from_frontmatter(frontmatter) == ["hot", "project/demo"]
    assert main.parse_tags_from_body(body) == ["hot", "planning", "research/note"]


def test_file_tree_entries_include_mtime_for_binary_headers(tmp_path) -> None:
    note = tmp_path / "note.md"
    attachment = tmp_path / "preview.pdf"
    note.write_text("# Note\n", encoding="utf-8")
    attachment.write_bytes(b"%PDF-1.4\n")

    main.invalidate_vault_caches()
    children = main.list_folder_children(str(tmp_path), "")
    by_name = {child["name"]: child for child in children}

    assert isinstance(by_name["note.md"]["mtime"], float)
    assert isinstance(by_name["preview.pdf"]["mtime"], float)


def test_mdvr_yaml_permissions_merge_and_vault_override(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    welcome_vault = tmp_path / "welcome-vault"
    welcome_vault.mkdir()
    config_content = """app:
  name: MDVR
server:
  write_without_auth: warn
  auth:
    enabled: false
defaults:
  mode: read-only
  permissions:
    files_format_read: ['.md', '.excalidraw']
    files_format_edit: ['.md', '.excalidraw']
    files_format_new: ['.md', '.excalidraw']
vaults:
  - id: welcome
    name: Welcome
    path: {path}
    mode: read-write
    permissions:
      edit: false
      new_files: false
""".format(path=welcome_vault.as_posix())
    config_path.write_text(config_content, encoding="utf-8")

    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    default_perms = main.get_vault_permissions(str(tmp_path / "general-vault"))
    welcome_perms = main.get_vault_permissions(str(welcome_vault))

    assert default_perms["edit"] is False
    assert default_perms["files_format_read"] == [".md", ".excalidraw"]
    assert welcome_perms["edit"] is False
    assert welcome_perms["files_format_edit"] == [".md", ".excalidraw"]
    assert main.can_read_file(str(welcome_vault), "Demo.excalidraw") is True
    assert main.can_create_file(str(welcome_vault), "Demo.excalidraw") is False


def test_mdvr_config_cache_invalidates_on_mtime_change(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    config_path.write_text(f"app:\n  name: MDVR\nvaults:\n  - id: one\n    path: {vault.as_posix()}\n", encoding="utf-8")
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    first = main.load_mdvr_config()
    assert first["app"]["name"] == "MDVR"

    main.invalidate_vault_caches()
    config_path.write_text(f"app:\n  name: MDVR-2\nvaults:\n  - id: one\n    path: {vault.as_posix()}\n", encoding="utf-8")
    second = main.load_mdvr_config()
    assert second["app"]["name"] == "MDVR-2"


def test_config_validation_rejects_bad_ids_relative_paths_and_bad_formats(tmp_path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()

    with pytest.raises(ValueError, match="URL-safe"):
        main.validate_mdvr_config({"vaults": [{"id": "../bad", "path": vault.as_posix()}]})

    with pytest.raises(ValueError, match="absolute"):
        main.validate_mdvr_config({"vaults": [{"id": "ok", "path": "relative"}]})

    with pytest.raises(ValueError, match="must start with"):
        main.validate_mdvr_config({
            "vaults": [{
                "id": "ok",
                "path": vault.as_posix(),
                "permissions": {"files_format_read": ["md"]},
            }]
        })


def test_config_validation_rejects_edit_formats_outside_read_formats(tmp_path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    with pytest.raises(ValueError, match="subset"):
        main.validate_mdvr_config({
            "defaults": {
                "permissions": {
                    "files_format_read": [".md"],
                    "files_format_edit": [".txt"],
                }
            },
            "vaults": [{"id": "ok", "path": vault.as_posix()}],
        })


def test_non_mapping_yaml_root_fails_validation_and_load(tmp_path, monkeypatch) -> None:
    with pytest.raises(ValueError, match="root must be a mapping"):
        main.validate_mdvr_config(["not", "a", "mapping"])  # type: ignore[arg-type]

    config_path = tmp_path / "mdvr.yaml"
    config_path.write_text("- not\n- a\n- mapping\n", encoding="utf-8")
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    with pytest.raises(ValueError, match="root must be a mapping"):
        main.load_mdvr_config()


def test_config_validation_fails_write_permissions_without_auth_by_default(tmp_path, monkeypatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    monkeypatch.delenv("MDVR_AUTH_ENABLED", raising=False)
    with pytest.raises(ValueError, match="write permissions"):
        main.validate_mdvr_config({
            "server": {"auth": {"enabled": False}},
            "vaults": [{"id": "ok", "path": vault.as_posix(), "mode": "read-write"}],
        })


def test_env_auth_enabled_takes_precedence_for_write_safety_validation(tmp_path, monkeypatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    monkeypatch.setenv("MDVR_AUTH_ENABLED", "1")

    config = main.validate_mdvr_config({
        "server": {"auth": {"enabled": False}},
        "vaults": [{"id": "ok", "path": vault.as_posix(), "mode": "read-write"}],
    })

    assert config["vaults"][0]["resolved_permissions"]["edit"] is True


def test_configured_vault_ids_resolve_to_absolute_paths(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "My Vault"
    vault.mkdir()
    config_path.write_text(
        f"vaults:\n  - id: personal-notes\n    name: Personal Notes\n    path: {vault.as_posix()}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    assert main.resolve_vault_root(cast(Any, FakeRequest({"x-vault-path": "personal-notes"}))) == vault.as_posix()
    assert main.list_vault_names()[0]["value"] == "personal-notes"


def test_docker_mounted_vault_roots_control_visible_vaults(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault_root = tmp_path / "vaults"
    demo = vault_root / "demo"
    archive = vault_root / "archive"
    demo.mkdir(parents=True)
    archive.mkdir()
    config_path.write_text(
        """app:
  name: MDVR
vaults: []
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("MDVR_VAULT_ROOTS", vault_root.as_posix())
    main.invalidate_vault_caches()

    options = main.list_vault_names()

    assert [option["id"] for option in options] == ["archive", "demo"]
    assert [option["path"] for option in options] == [archive.as_posix(), demo.as_posix()]
    assert main.resolve_vault_root(cast(Any, FakeRequest({"x-vault-path": "archive"}))) == archive.as_posix()


def test_mdvr_yaml_overrides_discovered_mount_settings(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault_root = tmp_path / "vaults"
    demo = vault_root / "demo"
    demo.mkdir(parents=True)
    config_path.write_text(
        """server:
  write_without_auth: warn
vaults:
  - id: demo
    name: Demo test vault
    path: /ignored/by/id/matching
    mode: read-write
    permissions:
      delete: true
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("MDVR_VAULT_ROOTS", vault_root.as_posix())
    monkeypatch.setenv("MDVR_AUTH_ENABLED", "1")
    main.invalidate_vault_caches()

    admin = main.api_admin_vault_config()

    assert admin["vaults"][0]["id"] == "demo"
    assert admin["vaults"][0]["name"] == "Demo test vault"
    assert admin["vaults"][0]["path"] == demo.as_posix()
    assert admin["vaults"][0]["resolved_permissions"]["edit"] is True
    assert admin["vaults"][0]["resolved_permissions"]["delete"] is True


def test_admin_vault_config_updates_yaml_and_invalidates_cache(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    old_vault = tmp_path / "old-vault"
    new_vault = tmp_path / "new-vault"
    old_vault.mkdir()
    new_vault.mkdir()
    config_path.write_text(
        f"""server:
  auth:
    enabled: true
    user: mdvr
    password: secret
vaults:
  - id: old
    name: Old Vault
    path: {old_vault.as_posix()}
    mode: read-only
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    monkeypatch.delenv("MDVR_AUTH_ENABLED", raising=False)
    main.invalidate_vault_caches()

    before = main.api_admin_vault_config()
    assert before["vaults"][0]["id"] == "old"
    assert "server" not in before

    updated = main.api_update_admin_vault_config(
        main.VaultConfigUpdateRequest(
            vaults=[
                main.ConfigVaultRequest(
                    id="new",
                    name="New Vault",
                    description="Updated from settings",
                    path=new_vault.as_posix(),
                    mode="read-write",
                    permissions={"delete": False},
                )
            ]
        )
    )

    saved = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert saved["server"]["auth"]["password"] == "secret"
    assert saved["vaults"][0]["id"] == "new"
    assert saved["vaults"][0]["name"] == "New Vault"
    assert updated["vaults"][0]["resolved_permissions"]["edit"] is True
    assert main.list_vault_names()[0]["value"] == "new"


def test_admin_vault_config_rejects_invalid_payload_without_rewriting(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    original = f"""server:
  auth:
    enabled: true
vaults:
  - id: ok
    path: {vault.as_posix()}
"""
    config_path.write_text(original, encoding="utf-8")
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    with pytest.raises(main.HTTPException) as exc:
        main.api_update_admin_vault_config(
            main.VaultConfigUpdateRequest(
                vaults=[main.ConfigVaultRequest(id="../bad", path=vault.as_posix())]
            )
        )

    assert exc.value.status_code == 422
    assert config_path.read_text(encoding="utf-8") == original


def test_admin_vault_config_write_requires_auth_enabled(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    config_path.write_text(
        f"""server:
  auth:
    enabled: false
vaults:
  - id: ok
    path: {vault.as_posix()}
    mode: read-only
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    monkeypatch.delenv("MDVR_AUTH_ENABLED", raising=False)
    main.invalidate_vault_caches()

    with pytest.raises(main.HTTPException) as exc:
        main.api_update_admin_vault_config(
            main.VaultConfigUpdateRequest(
                vaults=[main.ConfigVaultRequest(id="ok", path=vault.as_posix(), mode="read-only")]
            )
        )

    assert exc.value.status_code == 403


def test_admin_config_text_validates_before_rewriting(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    next_vault = tmp_path / "next"
    vault.mkdir()
    next_vault.mkdir()
    original = f"""server:
  auth:
    enabled: true
vaults:
  - id: ok
    path: {vault.as_posix()}
"""
    config_path.write_text(original, encoding="utf-8")
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    with pytest.raises(main.HTTPException) as exc:
        main.api_update_admin_config_text(main.ConfigTextUpdateRequest(content="vaults:\n  - id: bad\n    path: relative\n"))
    assert exc.value.status_code == 422
    assert config_path.read_text(encoding="utf-8") == original

    updated = f"""server:
  auth:
    enabled: true
vaults:
  - id: next
    name: Next
    path: {next_vault.as_posix()}
    mode: read-only
"""
    response = main.api_update_admin_config_text(main.ConfigTextUpdateRequest(content=updated))

    assert response["vaults"][0]["id"] == "next"
    assert config_path.read_text(encoding="utf-8").endswith("mode: read-only\n")


def test_config_writer_falls_back_when_bind_mount_rejects_atomic_replace(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    config_path.write_text("old: true\n", encoding="utf-8")

    def busy_replace(_src: str, _dst: str) -> None:
        raise OSError(main.errno.EBUSY, "Device or resource busy")

    monkeypatch.setattr(main.os, "replace", busy_replace)

    main._write_mdvr_config_text(config_path.as_posix(), "new: true")

    assert config_path.read_text(encoding="utf-8") == "new: true\n"


def test_admin_single_vault_config_text_updates_only_target_vault(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    one = tmp_path / "one"
    two = tmp_path / "two"
    one.mkdir()
    two.mkdir()
    config_path.write_text(
        f"""server:
  auth:
    enabled: true
vaults:
  - id: one
    name: One
    path: {one.as_posix()}
    mode: read-only
  - id: two
    name: Two
    path: {two.as_posix()}
    mode: read-only
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    text = main.api_admin_single_vault_config_text("two")
    assert "id: two" in text["content"]
    assert "id: one" not in text["content"]
    assert "Common modes" in text["content"]

    response = main.api_update_admin_single_vault_config_text(
        "two",
        main.ConfigTextUpdateRequest(
            content=f"""id: second
name: Second
path: {two.as_posix()}
mode: read-write
permissions:
  delete: false
"""
        ),
    )

    saved = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert [vault["id"] for vault in saved["vaults"]] == ["one", "second"]
    assert response["vault"]["id"] == "second"
    assert response["vault"]["resolved_permissions"]["edit"] is True


def test_missing_configured_vaults_remain_visible_with_error(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    missing = tmp_path / "vaults" / "missing"
    config_path.write_text(
        f"""vaults:
  - id: missing
    name: Missing Vault
    path: {missing.as_posix()}
    mode: read-only
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    options = main.list_vault_names()
    admin = main.api_admin_vault_config()

    assert options[0]["id"] == "missing"
    assert options[0]["available"] is False
    assert options[0]["status"] == "missing"
    assert "does not exist" in options[0]["error"]
    assert admin["vaults"][0]["available"] is False


def test_admin_remove_vault_config_updates_yaml_without_deleting_files(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    (first / "keep.md").write_text("keep", encoding="utf-8")
    config_path.write_text(
        f"""server:
  write_without_auth: warn
vaults:
  - id: first
    name: First
    path: {first.as_posix()}
    mode: read-only
  - id: second
    name: Second
    path: {second.as_posix()}
    mode: read-only
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("MDVR_AUTH_ENABLED", "1")
    main.invalidate_vault_caches()

    response = main.api_delete_admin_vault_config("first")
    saved = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    assert [vault["id"] for vault in response["vaults"]] == ["second"]
    assert [vault["id"] for vault in saved["vaults"]] == ["second"]
    assert (first / "keep.md").read_text(encoding="utf-8") == "keep"


def test_unknown_configured_vault_header_does_not_fall_back_to_base(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    base = tmp_path / "base"
    vault = tmp_path / "configured"
    base.mkdir()
    vault.mkdir()
    config_path.write_text(
        f"vaults:\n  - id: configured\n    path: {vault.as_posix()}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("MDVR_VAULT_PATH", str(base))
    main.invalidate_vault_caches()

    assert main.resolve_vault_root(cast(Any, FakeRequest({}))) == vault.as_posix()
    with pytest.raises(main.HTTPException) as exc:
        main.resolve_vault_root(cast(Any, FakeRequest({"x-vault-path": "unknown"})))
    assert exc.value.status_code == 404


def test_read_false_blocks_get_file_list_and_recent_routes(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text("secret", encoding="utf-8")
    config_path.write_text(
        f"""vaults:
  - id: locked
    path: {vault.as_posix()}
    mode: read-only
    permissions:
      read: false
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()
    request = cast(Any, FakeRequest({"x-vault-path": "locked"}))

    for route_call in (
        lambda: main.api_files(request),
        lambda: main.api_recent(request),
        lambda: main.api_get_file("note.md", request),
    ):
        with pytest.raises(main.HTTPException) as exc:
            route_call()
        assert exc.value.status_code == 403


def test_vault_can_be_selected_by_query_param_for_embedded_media(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    demo = tmp_path / "demo-vault"
    other = tmp_path / "other-vault"
    demo.mkdir()
    other.mkdir()
    (demo / "media.pdf").write_bytes(b"%PDF-1.4\n")
    config_path.write_text(
        f"""vaults:
  - id: demo
    path: {demo.as_posix()}
    mode: read-only
    permissions:
      files_format_read: ['.md', '.pdf']
      files_format_edit: ['.md']
      files_format_new: ['.md']
  - id: other
    path: {other.as_posix()}
    mode: read-only
    permissions:
      files_format_read: ['.md', '.pdf']
      files_format_edit: ['.md']
      files_format_new: ['.md']
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    response = main.api_get_file("media.pdf", cast(Any, FakeRequest(query_params={"vault": "demo"})))

    assert isinstance(response, main.FileResponse)
    assert response.media_type == "application/pdf"


def test_download_endpoint_streams_text_file_with_original_filename(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text("# Note\n", encoding="utf-8")
    config_path.write_text(
        f"""vaults:
  - id: demo
    path: {vault.as_posix()}
    mode: read-only
    permissions:
      files_format_read: ['.md']
      files_format_edit: ['.md']
      files_format_new: ['.md']
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()

    response = main.api_download_file("note.md", cast(Any, FakeRequest({"x-vault-path": "demo"})))

    assert isinstance(response, main.FileResponse)
    assert response.media_type != "application/json"
    assert 'filename="note.md"' in response.headers["content-disposition"]


def test_write_routes_enforce_permissions_and_file_formats(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text("old", encoding="utf-8")
    (vault / "blocked.txt").write_text("old", encoding="utf-8")
    config_path.write_text(
        f"""server:
  write_without_auth: warn
vaults:
  - id: demo
    path: {vault.as_posix()}
    mode: read-write
    permissions:
      files_format_read: ['.md', '.txt']
      files_format_edit: ['.md']
      files_format_new: ['.md']
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()
    request = cast(Any, FakeRequest({"x-vault-path": "demo"}))

    main.api_put_file(main.FileWriteRequest(path="note.md", content="new"), request)
    assert (vault / "note.md").read_text(encoding="utf-8") == "new"

    with pytest.raises(main.HTTPException) as exc:
        main.api_put_file(main.FileWriteRequest(path="blocked.txt", content="new"), request)
    assert exc.value.status_code == 403

    with pytest.raises(main.HTTPException) as create_exc:
        main.api_create_file(main.FileWriteRequest(path="blocked.txt", content="new"), request)
    assert create_exc.value.status_code == 403


def test_images_and_pdfs_are_readable_but_not_editable_when_allowed(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "photo.jpg").write_bytes(b"jpeg-bytes")
    (vault / "report.pdf").write_bytes(b"%PDF-1.4\n")
    config_path.write_text(
        f"""vaults:
  - id: demo
    path: {vault.as_posix()}
    mode: read-only
    permissions:
      files_format_read: ['.md', '.jpg', '.jpeg', '.pdf']
      files_format_edit: ['.md']
      files_format_new: ['.md']
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()
    request = cast(Any, FakeRequest({"x-vault-path": "demo"}))

    assert main.can_read_file(str(vault), "photo.jpg") is True
    assert main.can_read_file(str(vault), "report.pdf") is True
    assert main.can_edit_file(str(vault), "photo.jpg") is False
    assert main.can_edit_file(str(vault), "report.pdf") is False

    jpg_response = main.api_get_file("photo.jpg", request)
    pdf_response = main.api_get_file("report.pdf", request)

    assert isinstance(jpg_response, main.FileResponse)
    assert isinstance(pdf_response, main.FileResponse)
    assert jpg_response.media_type == "image/jpeg"
    assert pdf_response.media_type == "application/pdf"
    assert "content-disposition" not in jpg_response.headers
    assert "content-disposition" not in pdf_response.headers


def test_asset_upload_writes_attachments_when_new_files_allowed(tmp_path, monkeypatch) -> None:
    config_path = tmp_path / "mdvr.yaml"
    vault = tmp_path / "vault"
    vault.mkdir()
    config_path.write_text(
        f"""server:
  write_without_auth: warn
vaults:
  - id: demo
    path: {vault.as_posix()}
    mode: read-write
    permissions:
      files_format_read: ['.md', '.png', '.pdf']
      files_format_edit: ['.md']
      files_format_new: ['.md']
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("MDVR_CONFIG_FILE", str(config_path))
    main.invalidate_vault_caches()
    request = cast(Any, FakeRequest({"x-vault-path": "demo"}))

    response = main.api_upload_asset(
        main.AssetUploadRequest(
            filename="clip.png",
            content_type="image/png",
            content_base64=base64.b64encode(b"png-bytes").decode("ascii"),
            current_path="Projects/note.md",
        ),
        request,
    )

    assert response["path"] == "Projects/_attachments/clip.png"
    assert response["kind"] == "image"
    assert (vault / "Projects" / "_attachments" / "clip.png").read_bytes() == b"png-bytes"

    with pytest.raises(main.HTTPException) as exc:
        main.api_upload_asset(
            main.AssetUploadRequest(
                filename="script.js",
                content_type="application/javascript",
                content_base64=base64.b64encode(b"alert(1)").decode("ascii"),
                current_path="note.md",
            ),
            request,
        )
    assert exc.value.status_code == 403


def test_secure_path_blocks_traversal_and_symlink_escape(tmp_path) -> None:
    vault = tmp_path / "vault"
    outside = tmp_path / "outside"
    vault.mkdir()
    outside.mkdir()
    (outside / "secret.md").write_text("secret", encoding="utf-8")
    (vault / "link.md").symlink_to(outside / "secret.md")

    with pytest.raises(main.HTTPException) as traversal:
        main.secure_path(vault.as_posix(), "../outside/secret.md")
    assert traversal.value.status_code == 403

    with pytest.raises(main.HTTPException) as symlink:
        main.secure_path(vault.as_posix(), "link.md")
    assert symlink.value.status_code == 403


def test_readme_and_shipped_config_agree_on_write_without_auth() -> None:
    root = Path(__file__).resolve().parents[1]
    config = yaml.safe_load((root / "mdvr.yaml").read_text(encoding="utf-8"))
    docs = (root / "docs" / "configuration.md").read_text(encoding="utf-8")
    documented = set(re.findall(r"write_without_auth:\s*(fail|warn|allow)", docs))

    assert config["server"]["write_without_auth"] == "warn"
    assert documented == {"warn"}


def test_shipped_docker_defaults_enable_basic_auth() -> None:
    root = Path(__file__).resolve().parents[1]
    config = yaml.safe_load((root / "mdvr.yaml").read_text(encoding="utf-8"))
    compose = (root / "docker-compose.yml").read_text(encoding="utf-8")
    env_example = (root / ".env.example").read_text(encoding="utf-8")
    readme = (root / "README.md").read_text(encoding="utf-8")

    assert "auth" not in config["server"]
    assert "MDVR_AUTH_ENABLED: ${MDVR_AUTH_ENABLED:-1}" in compose
    assert "MDVR_AUTH_USER: ${MDVR_AUTH_USER:-mdvr}" in compose
    assert "MDVR_AUTH_PASSWORD: ${MDVR_AUTH_PASSWORD:-change-me}" in compose
    assert "MDVR_AUTH_ENABLED=1" in env_example
    assert "Default demo login is `mdvr` / `change-me`" in readme


def test_shipped_vaults_are_demo_and_obsidian_examples() -> None:
    root = Path(__file__).resolve().parents[1]
    config = yaml.safe_load((root / "mdvr.yaml").read_text(encoding="utf-8"))
    vaults = config["vaults"]

    assert [vault["id"] for vault in vaults] == ["demo", "obsidian"]
    assert vaults[0]["path"] == "/vaults/demo"
    assert vaults[0]["mode"] == "read-write"
    assert vaults[0]["permissions"]["delete"] is True
    assert ".txt" in config["defaults"]["permissions"]["files_format_new"]
    assert vaults[1]["path"] == "/vaults/obsidian"
    assert vaults[1]["mode"] == "read-only"


def test_demo_vault_is_seeded_only_when_mount_is_present() -> None:
    root = Path(__file__).resolve().parents[1]
    dockerfile = (root / "Dockerfile").read_text(encoding="utf-8")
    entrypoint = (root / "docker-entrypoint.sh").read_text(encoding="utf-8")

    assert "cp -a /app/welcome-vault/. /vaults/demo/" not in dockerfile
    assert "is_mountpoint \"$DEMO_VAULT_PATH\"" in entrypoint
    assert "cp -a \"$DEMO_SEED_PATH\"/. \"$DEMO_VAULT_PATH\"/" in entrypoint


def test_frontend_vault_selection_contract_is_checkbox_based() -> None:
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    index_html = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")

    assert "mdvr_selected_vaults" in app_js
    assert "mdvr_vault_aliases" in app_js
    assert "if (vaultId === 'real') return 'obsidian';" in app_js
    assert "checkbox.type = 'checkbox'" in app_js
    assert "vault-config-button" in app_js
    assert "settings/vault/" in app_js
    assert "/api/admin/vault-config" in app_js
    assert "/api/admin/vault-config/${encodeURIComponent(this.currentConfigVaultId)}/text" in app_js
    assert "view-vault-config" in index_html
    assert "single-vault-config-card" in index_html
    assert "single-vault-advanced-text" in index_html
    assert "this.vaultName = this.vaultLabel(this.activeVault) || data.name;" in app_js
    assert "home-upload-input" in index_html
    assert "icon) icon.textContent = 'upload';" in app_js
    assert "handleHomeUploadFiles" in app_js
    assert 'role="group"' in index_html
    assert "__all__" not in index_html


def test_frontend_recent_artifacts_filter_cached_files_before_limit() -> None:
    root = Path(__file__).resolve().parents[1]
    app_js = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")

    assert "this.homeRecentFiles = []" in app_js
    assert "recentSearchMatches(file, query)" in app_js
    assert ".filter(file => this.recentSearchMatches(file, query))" in app_js
    assert "const recentFiles = filteredFiles.slice(0, this.homeRecentLimit)" in app_js
