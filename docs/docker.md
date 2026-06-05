# mdvr Docker Guide

## Install From GHCR

Use the published image when you just want to run mdvr:

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

Start or update:

```bash
docker compose up -d
```

Open:

```text
http://localhost:8088
```

Default local login:

```text
user: mdvr
password: change-me
```

Change the password before sharing mdvr on a network.

## Demo Vault

The image contains a small demo vault. The Compose example mounts it as a named
volume:

```yaml
volumes:
  - mdvr-demo:/vaults/demo

volumes:
  mdvr-demo:
```

mdvr seeds that mounted volume at startup when `/vaults/demo` is empty. Changes
inside the demo vault persist in the named volume.

If you do not want demo content, remove both:

- `mdvr-demo:/vaults/demo`
- the top-level `mdvr-demo:` volume declaration

## Real Vaults

Mount each real vault under `/vaults/<id>`.

Read-only example:

```yaml
volumes:
  - /host/personal:/vaults/personal:ro
  - /host/archive:/vaults/archive:ro
```

mdvr discovers direct children of `/vaults` automatically. If Compose mounts one
vault, Settings shows one vault. If Compose mounts three vaults, Settings shows
three.

Use stable, URL-safe ids such as:

- `obsidian`
- `personal`
- `archive`
- `work-notes`

## Write Access

Start real vaults read-only:

```yaml
volumes:
  - /absolute/path/to/your/vault:/vaults/obsidian:ro
```

To allow writes, do both deliberately:

1. Remove `:ro` from the Docker mount.
2. Change that vault mode to `read-write` or `admin` in Settings or `mdvr.yaml`.

Do this only with auth enabled and backups already tested.

## Settings And `mdvr.yaml`

Docker Compose controls mounted folders. `mdvr.yaml` controls display names,
modes, and permissions for those mounted folders.

If you want Settings to save config changes, mount `mdvr.yaml` writable:

```yaml
volumes:
  - ./mdvr.yaml:/app/mdvr.yaml
```

If you want config to be read-only from the browser, mount it with `:ro`.

More detail: [Vault configuration](vaults.md) and [YAML reference](configuration.md).

## Stop, Update, And Remove

Stop the container:

```bash
docker compose down
```

Start again after changing Compose:

```bash
docker compose up -d
```

Remove named volumes only when you intentionally want to delete their data:

```bash
docker compose down -v
```

Do not run `down -v` casually if the Compose file contains named volumes you
care about.

## Build From Source

For local development from a checkout:

```bash
docker compose up -d --build
```

Run tests in a Docker image with dev dependencies:

```bash
MDVR_INSTALL_DEV_DEPS=1 docker compose build mdvr
MDVR_INSTALL_DEV_DEPS=1 docker compose run --rm mdvr pytest -q
```
