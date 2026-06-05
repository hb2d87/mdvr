#!/bin/sh
set -eu

CONFIG_FILE="${MDVR_CONFIG_FILE:-/app/mdvr.yaml}"
AUTH_FILE="${MDVR_AUTH_FILE:-/run/mdvr.htpasswd}"
DEMO_VAULT_PATH="${MDVR_DEMO_VAULT_PATH:-/vaults/demo}"
DEMO_SEED_PATH="${MDVR_DEMO_SEED_PATH:-/app/welcome-vault}"

AUTH_ENABLED="${MDVR_AUTH_ENABLED:-}"
AUTH_USER="${MDVR_AUTH_USER:-}"
AUTH_PASSWORD="${MDVR_AUTH_PASSWORD:-}"
AUTH_REALM="${MDVR_AUTH_REALM:-MDVR}"

is_mountpoint() {
  target="$1"
  grep -q " ${target} " /proc/self/mountinfo 2>/dev/null
}

if is_mountpoint "$DEMO_VAULT_PATH" && [ -d "$DEMO_SEED_PATH" ]; then
  mkdir -p "$DEMO_VAULT_PATH"
  if [ -z "$(find "$DEMO_VAULT_PATH" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then
    cp -a "$DEMO_SEED_PATH"/. "$DEMO_VAULT_PATH"/
  fi
fi

if [ -z "$AUTH_ENABLED" ] || [ -z "$AUTH_USER" ] || [ -z "$AUTH_PASSWORD" ]; then
  CONFIG_PARSED="$(python - "$CONFIG_FILE" <<'PY'
import os
import sys
try:
    import yaml
except Exception:
    print("0\t\t\tMDVR")
    raise SystemExit(0)

path = sys.argv[1]
data = {}
if path and os.path.exists(path):
    with open(path, 'r', encoding='utf-8') as handle:
        data = yaml.safe_load(handle) or {}
server = data.get('server', {}) if isinstance(data, dict) else {}
auth = server.get('auth', {}) if isinstance(server, dict) else {}
if not isinstance(auth, dict) or not auth:
    auth = data.get('auth', {}) if isinstance(data, dict) else {}
enabled = str(auth.get('enabled', '')).strip().lower()
user = str(auth.get('user', '') or '')
password = str(auth.get('password', '') or '')
realm = str(auth.get('realm', 'MDVR') or 'MDVR')
print(f"{enabled}\t{user}\t{password}\t{realm}")
PY
)"
  CONFIG_AUTH_ENABLED="$(printf '%s' "$CONFIG_PARSED" | cut -f1 | tr -d ' ')"
  CONFIG_AUTH_USER="$(printf '%s' "$CONFIG_PARSED" | cut -f2)"
  CONFIG_AUTH_PASSWORD="$(printf '%s' "$CONFIG_PARSED" | cut -f3)"
  CONFIG_AUTH_REALM="$(printf '%s' "$CONFIG_PARSED" | cut -f4)"
  if [ -z "$AUTH_ENABLED" ]; then AUTH_ENABLED="$CONFIG_AUTH_ENABLED"; fi
  if [ -z "$AUTH_USER" ]; then AUTH_USER="$CONFIG_AUTH_USER"; fi
  if [ -z "$AUTH_PASSWORD" ]; then AUTH_PASSWORD="$CONFIG_AUTH_PASSWORD"; fi
  if [ -z "$AUTH_REALM" ] && [ -n "$CONFIG_AUTH_REALM" ]; then AUTH_REALM="$CONFIG_AUTH_REALM"; fi
fi

case "${AUTH_ENABLED:-0}" in
  1|true|TRUE|yes|YES|on|ON)
  if [ -z "$AUTH_USER" ] || [ -z "$AUTH_PASSWORD" ]; then
    echo "MDVR auth requires both MDVR_AUTH_USER and MDVR_AUTH_PASSWORD" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$AUTH_FILE")"
  htpasswd -bcB "$AUTH_FILE" "$AUTH_USER" "$AUTH_PASSWORD" >/dev/null
  ;;
esac

python /app/tools/mdvr_nginx.py > /etc/nginx/sites-available/default
rm -f /etc/nginx/sites-enabled/default
ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default

service nginx start
exec uvicorn main:app --host 0.0.0.0 --port 8000
