# AGENTS.md

## Project purpose

MDVR is a small self-hosted browser app for reading and optionally editing Markdown and Excalidraw vaults.
It runs in Docker and supports multiple vaults with explicit permissions.

## Safety-first rules

- Keep real vaults read-only by default.
- Preserve the two-lock editing model:
  - Docker mount permission, such as `:ro` or `:rw`
  - MDVR config mode, such as `read-only` or `read-write`
- Do not weaken path safety, auth, or permission checks.
- Never invent support for unsupported file types.
- Do not claim JPG/PDF embedding, gallery insertion, or mobile paste support unless it is implemented and tested.
- Update docs whenever config, auth, permissions, or Docker behavior changes.

## Working expectations

- Run available tests before final response.
- Run available lint/build checks before final response.
- If no tests exist, say so clearly.
- If a command is not already in the repo, do not fabricate it.

## Current known checks

Use the checks that already exist in this repo when relevant:

```bash
pytest -q tests/test_mdvr_core.py
python -m py_compile main.py tools/mdvr_link.py tests/test_mdvr_core.py
node --check app/static/app.js
node --check app/static/excalidraw-bridge.js
```

## Change discipline

- Prefer small, reviewable changes.
- Keep demo-vault-first behavior intact.
- Keep the real vault read-only unless the operator explicitly changes both the mount and the config.
- If you touch permissions, verify both the UI and backend behavior.

## Notes for future agents

- Preserve exact vault-relative identity.
- Keep legacy compatibility only when it does not weaken safety.
- Be explicit about assumptions and TODOs.
- Do not overstate readiness or completeness.
