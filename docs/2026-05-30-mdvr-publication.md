# mdvr publication checklist

This note tracks the work needed to make mdvr public-ready and easy to share.

## Scope

- Brand the project as `mdvr`; treat "markdown vault reader" as abbreviation context
- Keep exact vault-relative paths as canonical identities
- Support multiple vaults from a parent folder plus explicit extra vault paths
- Protect the deployment with a lightweight and established auth layer
- Keep the repo clean enough for a public GitHub release

## Decisions

- **Auth:** nginx HTTP Basic Auth with an `htpasswd` file
- **Vault discovery:**
  - visible top-level folders under `MDVR_VAULT_PATH`
  - optional additional vault roots via `MDVR_VAULTS`
- **Canonical identity:** exact vault-relative path, not a slug
- **Collision handling:** spaces are preserved; `file like this.md` and `file_like_this.md` remain distinct
- **PDF rendering:** vendored Mozilla PDF.js for lightweight browser canvas previews; revisit EmbedPDF later if full reader controls become a priority

## Files updated for publication

- `README.md`
- `Dockerfile`
- `docker-compose.yml`
- `docker-entrypoint.sh`
- `tools/mdvr_nginx.py`
- `tools/mdvr_link.py`
- `app/static/app.js`
- `app/static/index.html`
- `main.py`
- `tests/test_mdvr_core.py`
- `.gitignore`
- `.env.example`
- `LICENSE`

## Verification checklist

- [ ] `pytest -q`
- [ ] `python -m py_compile main.py tools/mdvr_link.py tools/mdvr_nginx.py tests/test_mdvr_core.py`
- [ ] Build container successfully
- [ ] Confirm auth prompt appears when enabled
- [ ] Confirm vault selector shows multiple vaults
- [ ] Confirm a file with spaces and an underscore counterpart open as distinct files
- [ ] Confirm deep links use `/:vault/path/to/file.md`

## Notes

- The repo still contains compatibility fallback keys in `localStorage` so existing browser state should survive the rename.
- For sharing note links, prefer the exact path-style helper output from `tools/mdvr_link.py`.
