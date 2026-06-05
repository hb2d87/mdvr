# Vault Configuration

This guide explains vault setup from the Docker Compose level down to advanced
YAML overrides.

## The Short Version

Vaults are Docker mounts.

```yaml
volumes:
  - /host/personal:/vaults/personal:ro
  - /host/archive:/vaults/archive:ro
```

mdvr scans `/vaults` and shows each direct child folder as a vault:

- `/vaults/personal` becomes `personal`
- `/vaults/archive` becomes `archive`

Settings can rename those vaults and change permissions, but Settings cannot add
or remove Docker mounts from the running container.

## One Vault

If you mount one real vault:

```yaml
volumes:
  - /host/obsidian:/vaults/obsidian:ro
```

Home shows a flat file tree for that vault.

## Multiple Vaults

If you mount multiple vaults:

```yaml
volumes:
  - /host/personal:/vaults/personal:ro
  - /host/work:/vaults/work:ro
  - /host/archive:/vaults/archive:ro
```

Home can search across selected vaults. When more than one vault is selected,
the file tree adds one top level per vault.

## Demo Vault

The published image includes demo seed content. The recommended Compose file
mounts the demo vault explicitly:

```yaml
volumes:
  - mdvr-demo:/vaults/demo

volumes:
  mdvr-demo:
```

Keep it if you want a safe write-enabled test vault. Remove it if you only want
your own notes. Without the `/vaults/demo` mount, the bundled demo settings in
`mdvr.yaml` are only an unused overlay and should not appear in the vault list
when another `/vaults/<id>` mount exists.

## Read-Only Vs Writable

There are two separate gates for writes:

1. Docker mount mode
2. mdvr vault mode

Read-only Docker mount:

```yaml
volumes:
  - /host/obsidian:/vaults/obsidian:ro
```

Writable Docker mount:

```yaml
volumes:
  - /host/obsidian:/vaults/obsidian
```

mdvr also needs a writable mode:

```yaml
vaults:
  - id: obsidian
    name: Obsidian
    path: /vaults/obsidian
    mode: read-write
```

If either side is read-only, writes should not happen.

## Modes

`read-only`:

- read files
- no edit, create, rename, or delete actions

`read-write`:

- read files
- edit, create, and rename files
- delete remains disabled unless explicitly enabled

`admin`:

- read files
- edit, create, rename, and soft-delete files

Use `read-only` first for real vaults. Use the demo vault to test writes.

## Rename A Vault

You can change the display name without changing the Docker mount:

```yaml
vaults:
  - id: obsidian
    name: My Notes
    path: /vaults/obsidian
    mode: read-only
```

The id remains `obsidian`, so URLs still use `/obsidian/...`.

## Add More Vaults

Add another Docker mount:

```yaml
volumes:
  - /host/recipes:/vaults/recipes:ro
```

Then optionally add a YAML entry:

```yaml
vaults:
  - id: recipes
    name: Recipes
    path: /vaults/recipes
    mode: read-only
```

The YAML entry is for settings. The Docker mount is what makes the vault exist.

## Unavailable Vaults

If a configured vault path is missing or unreadable, mdvr should show it with an
error instead of silently hiding the problem. Fix the Docker mount or remove the
stale YAML entry.

## File Types

Readable defaults include Markdown, text, Excalidraw, common image formats, and
PDF.

Writable defaults are intentionally narrower:

- `.md`
- `.markdown`
- `.txt`
- `.excalidraw`

Only add more writable formats when you know the editor path supports them.

## Advanced YAML

Advanced settings live in `mdvr.yaml`.

Use it for:

- custom display names
- vault descriptions
- read/write modes
- delete permission
- file extension allowlists
- strict config validation behavior

Full reference: [YAML reference](configuration.md).
