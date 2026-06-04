#!/usr/bin/env python3
"""Render the nginx config used by the MDVR container.

The Docker entrypoint uses this helper so the config is easy to test and the
optional auth block stays in one place.
"""

from __future__ import annotations

import os
import yaml


def env_flag(name: str, default: str = "0") -> bool:
    value = os.environ.get(name, default).strip().lower()
    return value in {"1", "true", "yes", "on"}


def load_auth_settings() -> tuple[bool, str, str]:
    config_file = os.environ.get("MDVR_CONFIG_FILE", "/app/mdvr.yaml")
    config = {}
    if os.path.exists(config_file):
        try:
            with open(config_file, "r", encoding="utf-8") as handle:
                config = yaml.safe_load(handle) or {}
        except Exception:
            config = {}
    server = config.get("server", {}) if isinstance(config, dict) else {}
    auth = server.get("auth", {}) if isinstance(server, dict) else {}
    if not isinstance(auth, dict) or not auth:
        auth = config.get("auth", {}) if isinstance(config, dict) else {}
    if not isinstance(auth, dict):
        auth = {}
    if os.environ.get("MDVR_AUTH_ENABLED"):
        enabled = env_flag("MDVR_AUTH_ENABLED")
    else:
        enabled = auth.get("enabled")
    if enabled is None:
        enabled = env_flag("MDVR_AUTH_ENABLED") or bool(os.environ.get("MDVR_AUTH_USER") and os.environ.get("MDVR_AUTH_PASSWORD"))
    else:
        enabled = str(enabled).strip().lower() in {"1", "true", "yes", "on"}
    realm = str(auth.get("realm") or os.environ.get("MDVR_AUTH_REALM", "MDVR"))
    auth_file = str(auth.get("file") or os.environ.get("MDVR_AUTH_FILE", "/run/mdvr.htpasswd"))
    return bool(enabled), realm, auth_file


def render_nginx_config(auth_enabled: bool, auth_realm: str, auth_file: str) -> str:
    auth_block = ""
    if auth_enabled:
        auth_block = f'auth_basic "{auth_realm}";\n    auth_basic_user_file {auth_file};'

    lines = [
        "server {",
        "    listen 0.0.0.0:8080;",
        "    server_name _;",
        "    root /app/app/static;",
        "    index index.html;",
        "    server_tokens off;",
        "    client_max_body_size 12M;",
    ]
    if auth_block:
        lines.extend([f"    {line}" for line in auth_block.splitlines()])
    lines.extend([
        "    location / {",
        "        try_files $uri $uri/ /index.html;",
        "        add_header X-Content-Type-Options nosniff always;",
        "        add_header X-Frame-Options SAMEORIGIN always;",
        "        add_header Referrer-Policy strict-origin-when-cross-origin always;",
        "    }",
        "    location /api/ {",
        "        proxy_pass http://127.0.0.1:8000;",
        "        proxy_set_header Host $host;",
        "        proxy_set_header X-Real-IP $remote_addr;",
        "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
        "        proxy_set_header X-Forwarded-Proto $scheme;",
        "        proxy_read_timeout 30s;",
        "        proxy_connect_timeout 10s;",
        "    }",
        "    location /ws {",
        "        proxy_pass http://127.0.0.1:8000;",
        "        proxy_http_version 1.1;",
        "        proxy_set_header Upgrade $http_upgrade;",
        '        proxy_set_header Connection "upgrade";',
        "        proxy_set_header Host $host;",
        "        proxy_set_header X-Forwarded-Proto $scheme;",
        "        proxy_read_timeout 86400s;",
        "    }",
        "    location ~ /\\. {",
        "        deny all;",
        "        return 404;",
        "    }",
        "}",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    auth_enabled, auth_realm, auth_file = load_auth_settings()
    print(render_nginx_config(auth_enabled=auth_enabled, auth_realm=auth_realm, auth_file=auth_file), end="")


if __name__ == "__main__":
    main()
