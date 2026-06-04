# mdvr security guide

mdvr is an early-alpha self-hosted reader/editor for vault files.
Treat it carefully.

## Plain-language threat model

mdvr is a web app that can read and, depending on config, write files in a mounted vault.
That means the main risk is simple:

- a browser session might read files it should not read
- a browser session might write or rename files it should not touch
- a bad config might expose your only copy of important notes

## Main risk

The main risk is a web app with file write access to a personal vault.

Do not mount your only real vault read-write without backups.

## Recommended deployment pattern

Strongly prefer:
- LAN-only access, or
- Tailscale-only access

Do **not** expose mdvr directly to the public internet unless you really understand the risk and have reviewed the configuration.

## Auth recommendations

- Keep auth enabled for any non-trivial deployment
- Use a long random password
- Prefer the nginx Basic Auth layer for public/demo access control
- Docker enables Basic Auth by default with `mdvr` / `change-me`; change that password before sharing the service
- Treat `auth.enabled: false` as a warning state, not the normal state

If you must run without auth:
- keep the demo vault only
- keep the real vault read-only
- do not expose it beyond a trusted network

## Permission model

mdvr should protect writes in three layers:

1. **UI layer**
   - hide or disable actions the user cannot perform

2. **Backend layer**
   - return `403` for forbidden actions

3. **Filesystem layer**
   - the mounted host path and OS permissions are the final wall

Do not rely on the UI alone.

## Path traversal protection

The app must not allow `../` style escapes or absolute-path tricks that leave the selected vault.

Expected protections:
- normalize requested paths
- resolve against the selected vault root
- reject paths that escape the vault
- reject unsafe parent directories

## Symlink escape protection

Symlinks can point outside the vault even when the visible path looks safe.

Expected protections:
- resolve real paths before reads or writes
- reject targets that escape the vault root
- test symlink cases explicitly

## Atomic writes

Write operations should be atomic when possible.

Recommended approach:
- write to a temporary file
- flush and sync
- replace the target atomically

This reduces the chance of partial files if the process crashes.

## Delete policy

Delete should be disabled by default.

If delete exists:
- prefer trash / soft delete
- keep a recovery path
- do not make hard delete the default public behavior

## Markdown rendering and XSS

If raw HTML rendering is supported, or if the renderer behavior is unclear, assume XSS risk until verified.

Recommendations:
- sanitize rendered HTML
- do not trust frontmatter or markdown content as safe HTML
- test script injection and malformed content cases

## Upload And Attachment Warning

mdvr supports limited uploads:

- Home can upload Markdown and text files into a writable vault.
- Reader/edit mode can attach images and PDFs beside the current note.

For upload-related changes:

- validate file types
- validate paths
- validate size limits
- reject uploads that can escape the vault
- keep real vaults read-only until backups are tested

## Backup and versioning

Before enabling write access to a real vault:
- make a backup
- verify restore
- keep version history if you can

A reasonable setup is:
- file backups
- git for notes that fit version control
- a separate copy outside the mdvr host

## What counts as a security issue

Report issues such as:
- path traversal
- auth bypass
- permission bypass
- write access despite read-only config
- symlink escape
- XSS from Markdown rendering
- unsafe upload handling
- arbitrary file read/write outside the vault

## Report vulnerabilities

Please report security issues through the process in `SECURITY.md`.
Do not paste exploit details into a public issue.
If you want to suggest non-sensitive hardening, keep the description high level.

## Early alpha warning

mdvr is small, useful, and still early.
Treat it as best-effort software and test carefully with a copied vault first.
