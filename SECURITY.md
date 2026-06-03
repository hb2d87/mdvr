# Security policy

## Supported versions

MDVR is early alpha and best-effort only.
We do not promise long-term security support for every past version.

## Reporting vulnerabilities

Please report security issues privately through the process described in this file.
Do not disclose exploit details publicly before a fix is available.

If you are unsure whether something is a security issue, report it anyway and keep the description concise.

## What counts as a security issue

Examples include:
- path traversal
- auth bypass
- permission bypass
- write access despite read-only config
- symlink escape
- XSS from Markdown rendering
- unsafe upload handling
- arbitrary file read/write outside the vault

## What to include in a report

Please include:
- version or commit
- deployment method
- config snippet with secrets removed
- steps to reproduce
- expected behavior
- actual behavior
- logs or screenshots if relevant

If the issue affects a real vault, say so clearly.
If the vault mount was `:ro` or `:rw`, include that too.

## Response expectations

This is a small personal open-source project.
Response time may be best effort.
We will try to confirm, reproduce, and fix serious issues when possible.

## Good practice for reporters

- do not post proof-of-concept exploits in public issues
- do not target other users' data
- do not test on vaults you do not own or control
- keep the report focused and reproducible
