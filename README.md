# mdvr (Markdown Vault Reader)

mdvr is a small self-hosted browser app for reading Markdown notes, Excalidraw
files, images, PDFs, and text files from mounted vaults. It also has optional
write actions for vaults that are configured as writable.

## Why

I got tired of configuring CouchDB and LiveSync, and I have some devices where I
cannot install third-party apps. I tried to find something similar, but nothing
was a full fit, so I decided to make my own.

The base idea is simple: keep a central vault as the source of truth. Everything
else can read from it, make occasional changes when allowed, and share access
inside a local network or over Tailscale.

This project was created with heavy LLM assistance, but it still took time to
polish and make work reliably. I hope it is useful if you need something
lightweight that works in any web browser.

## Screenshots

| Demo Home | Media Reader | Settings |
| --- | --- | --- |
| ![Home view with recent files and file tree](docs/assets/screenshots/mdvr-home-demo.png) | ![Reader view with image and PDF preview](docs/assets/screenshots/mdvr-media-reader.png) | ![Settings view with vault selection and theme palette](docs/assets/screenshots/mdvr-settings.png) |

## Quick Install

Use the published Docker image:

```yaml
services:
  mdvr:
    image: ghcr.io/hb2d87/mdvr:latest
    container_name: mdvr
    ports:
      - "8088:8080"
    volumes:
      # Demo vault. Remove this line and the mdvr-demo volume below if you do
      # not want demo content.
      - mdvr-demo:/vaults/demo

      # Your vault. Start read-only.
      - /absolute/path/to/your/obsidian-vault:/vaults/obsidian:ro
    environment:
      MDVR_AUTH_ENABLED: "1"
      MDVR_AUTH_USER: mdvr
      MDVR_AUTH_PASSWORD: change-this-password
      MDVR_AUTH_REALM: MDVR
    restart: unless-stopped

volumes:
  mdvr-demo:
```

Start it:

```bash
docker compose up -d
```

Open:

```text
http://localhost:8088
```

Default demo login is `mdvr` / `change-me` only for local testing. Change
`MDVR_AUTH_PASSWORD` before sharing the service.

The demo vault is a named Docker volume seeded at startup when `/vaults/demo` is
mounted and empty. Remove `mdvr-demo:/vaults/demo` and the `mdvr-demo` volume
block if you only want your own vault.

## What It Does

- Reads one or more Docker-mounted vaults from the browser
- Supports folders, recent files, search, tags, links, and backlinks
- Uses stable URLs such as `/demo/Research/note.md`
- Renders Markdown, text, Excalidraw, images, and first-page PDF previews
- Allows write actions only for vaults configured as writable
- Uses nginx Basic Auth by default in Docker

## Configuration Model

Docker Compose decides which vault folders exist by mounting them under
`/vaults/<id>`.

`mdvr.yaml` and Settings customize those discovered vaults: display name, mode,
description, and permissions. The browser cannot add or remove Docker volume
mounts from a running container.

Safe default:

- keep real vaults mounted read-only with `:ro`
- test write actions in the demo vault first
- enable writes for a real vault only after backups are in place

## Documentation

- [Docker install and operations](docs/docker.md)
- [Vault configuration](docs/vaults.md)
- [YAML reference](docs/configuration.md)
- [Security notes](docs/security.md)
- [Tailscale notes](docs/tailscale.md)

## Development

Development notes live in [docs/docker.md](docs/docker.md#build-from-source).

## License

MIT
