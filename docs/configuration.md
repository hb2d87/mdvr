# mdvr configuration

This file explains the YAML config structure used by mdvr.

## Full example `config.yml`

This example is safe by default:
- the internal demo vault is write-enabled
- the Obsidian vault is read-only
- auth is enabled
- delete is enabled only for the disposable demo vault
- only markdown, plain text, and Excalidraw files are writable by default

```yaml
app:
  name: MDVR
  description: Browser reader for markdown vaults

server:
  host: 0.0.0.0
  port: 8080
  unknown_keys: fail
  write_without_auth: warn
  auth:
    enabled: true
    realm: MDVR
    user: mdvr
    password: replace-with-a-long-secret
    file: /run/mdvr.htpasswd

defaults:
  mode: read-only
  permissions:
    read: true
    edit: false
    new_files: false
    rename: false
    delete: false
    upload: false
    hide_unreadable_files: true
    files_format_read:
      - .md
      - .excalidraw
      - .txt
    files_format_edit:
      - .md
      - .excalidraw
      - .txt
    files_format_new:
      - .md
      - .excalidraw
      - .txt
    files_format_upload: []

vaults:
  - id: demo
    name: Demo test vault
    description: Safe internal demo vault. You can delete and recreate it.
    path: /app/welcome-vault
    mode: read-write
    permissions:
      delete: true

  - id: obsidian
    name: Obsidian
    description: External Obsidian vault mounted from the host. Read-only by default.
    path: /vaults/obsidian
    mode: read-only
    permissions:
      delete: false

  # Local-only testing example.
  # Use this only with auth enabled, backups in place, and a deliberate
  # decision to make the Obsidian vault writable.
  - id: obsidian-write
    name: Obsidian (write enabled)
    description: Use only with backups and explicit operator approval.
    path: /vaults/obsidian
    mode: read-write
    permissions:
      delete: false
```

## What the top-level keys mean

### `app`

General app metadata.

Common keys:
- `name` — display name used in the UI and docs
- `description` — short human-readable summary

### `server`

Server runtime and auth settings.

Common keys:
- `host` — bind address inside the container or local process
- `port` — listen port inside the container
- `unknown_keys` — how strict validation is for unexpected YAML keys (`fail` or `warn`)
- `write_without_auth` — how strict the app is when write access exists without auth (`fail`, `warn`, or `allow`)
- `auth.enabled` — turn auth on or off
- `auth.realm` — HTTP Basic Auth realm
- `auth.user` / `auth.password` / `auth.file` — auth credentials and htpasswd file path

### `defaults`

Fallback policy applied to vaults that do not override a field.

Common keys:
- `mode` — default vault mode
- `permissions` — default per-action permissions and file-format allowlists

### `vaults`

A list of configured vaults.

The browser lets users select one or more available vaults for Home. One
selected vault keeps the file tree flat. Multiple selected vaults add a vault
level in the Home file tree and combine recent files/search. Opening a file
switches to that file's vault id, so actions use that vault's permissions.

Each vault should have:
- `id` — stable identifier used in the UI and links
- `name` — display label
- `description` — optional short note for humans
- `path` — absolute container path to the vault root
- `mode` — base permission preset
- `permissions` — per-vault overrides

## Vault modes

Supported modes:

- `read-only`
  - read allowed
  - edit, new file, rename, delete, upload disabled
- `read-write`
  - read, edit, new file, rename allowed
  - delete and upload disabled by default
- `admin`
  - read, edit, new file, rename, delete, upload allowed

Per-vault `permissions` override the selected mode.

Example:

```yaml
mode: read-write
permissions:
  delete: false
```

## Vault field reference

### `id`

- Stable vault identifier
- Used for links and selection
- Must be unique
- Should be URL-safe: lowercase letters, numbers, hyphens, underscores

### `name`

- Human-friendly label shown in the UI
- Can contain spaces and normal display punctuation

### `description`

- Optional short explanation shown in UI lists or docs
- Keep it brief

### `path`

- Absolute container path
- Must point to a mounted vault directory inside the container
- Never accept arbitrary host paths from the browser UI

### `mode`

- One of `read-only`, `read-write`, `admin`
- Sets the baseline action permissions for the vault

### `permissions`

- Per-vault overrides for the selected mode
- Useful for disabling delete even in `read-write`
- Can also override file-format allowlists

## File-format allowlists

mdvr currently uses these allowlist fields:

- `files_format_read`
- `files_format_edit`
- `files_format_new`
- `files_format_upload` is reserved for future broader upload workflows

How they map:

- `read` — which file extensions can be opened or listed
- `edit` — which file extensions can be saved in place
- `create` — which file extensions can be created with New file
- `upload` — reserved for future upload categories beyond current media attachment behavior

Important rules:

- extensions should start with `.`
- editable formats must also be readable
- creatable formats must also be readable
- attached media formats should also be readable

Keep the default formats to:

- `.md`
- `.excalidraw`
- `.txt`

Only add more if the code path, UI, and tests really support them.

## Media and PDF rendering

mdvr supports image and PDF attachments for readable vaults when the active file
can be edited and the vault allows creating new files. Attachments are stored in
an `_attachments` folder beside the current note and can be added with paste,
drag/drop, or the reader context menu.

Supported attachment formats:

- images: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.svg`, `.ico`
- PDFs: `.pdf`

Markdown preview renders images inline. PDF links render a first-page canvas
preview with vendored Mozilla PDF.js runtime files under `app/static/vendor/pdfjs`.
mdvr uses PDF.js for the current lightweight reader because it solves browser
rendering directly without adding a server-side Java dependency. EmbedPDF remains
a good future candidate if mdvr needs richer PDF reader controls such as search,
zoom UI, annotations, or PDFium-backed rendering.

## Validation expectations

mdvr should reject or warn on unsafe config.

Expected rules:

- vault IDs must be unique
- vault IDs should be URL-safe
- paths must be absolute container paths
- editable formats must also be readable
- creatable formats must also be readable
- extensions should start with `.`
- unknown keys should fail or warn clearly
- `auth.enabled: false` should log a warning
- write-enabled configs without auth should fail or warn depending on `server.write_without_auth`
- `delete: true` should trigger a strong warning

## Safe examples

### Demo test vault write-enabled

This is the default safe pattern:
- demo vault: `read-write`
- obsidian vault: `read-only`
- auth enabled
- demo delete enabled as soft-delete into `.mdvr-trash`

```yaml
vaults:
  - id: demo
    name: Demo test vault
    path: /app/welcome-vault
    mode: read-write
    permissions:
      delete: true

  - id: obsidian
    name: Obsidian
    path: /vaults/obsidian
    mode: read-only
```

### Obsidian vault read-only

Recommended first-run setup for personal notes:

```yaml
vaults:
  - id: obsidian
    name: Obsidian
    path: /vaults/obsidian
    mode: read-only
```

Also keep the Docker mount read-only:

```yaml
volumes:
  - /absolute/host/path/to/your/vault:/vaults/obsidian:ro
```

### Obsidian vault read-write with warnings

Only do this deliberately, with auth enabled and backups in place:

```yaml
vaults:
  - id: obsidian
    name: Obsidian
    path: /vaults/obsidian
    mode: read-write
    permissions:
      delete: false
```

Then remove `:ro` from the Docker mount. Do not do this on your only copy of important notes.

## Notes

- mdvr uses exact vault-relative paths as canonical identity.
- `file like this.md` and `file_like_this.md` are different paths.
- If you change config structure or permission names, update the docs and tests together.
