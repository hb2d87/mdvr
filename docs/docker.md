# mdvr Docker guide

## Basic Docker Compose install

mdvr is designed to run as a single Docker service.

Typical flow:

```bash
docker compose up -d --build
```

Open the app at:

```text
http://localhost:8088
```

Default login:

```text
user: mdvr
password: change-me
```

Change the password before exposing mdvr outside a trusted local machine.

The container listens on port `8080`, and the default host mapping is `8088:8080`.
Port `8088` is the project default for Docker Compose.

## Example `docker-compose.yml`

This is the intended safe pattern:

```yaml
services:
  mdvr:
    container_name: mdvr
    build:
      context: .
    ports:
      - "8088:8080"
    volumes:
      # Internal demo vault. Safe to delete/recreate.
      - ./welcome-vault:/app/welcome-vault

      # Obsidian example vault. Start read-only.
      - ${MDVR_OBSIDIAN_VAULT:-./vaults/obsidian}:/vaults/obsidian:ro

      # Config file.
      - ./mdvr.yaml:/app/mdvr.yaml:ro
    environment:
      MDVR_CONFIG_FILE: /app/mdvr.yaml
      MDVR_AUTH_ENABLED: ${MDVR_AUTH_ENABLED:-1}
      MDVR_AUTH_USER: ${MDVR_AUTH_USER:-mdvr}
      MDVR_AUTH_PASSWORD: ${MDVR_AUTH_PASSWORD:-change-me}
    restart: unless-stopped
```

## Volumes explained

### Internal test vault

- Mounted inside the container as `/app/welcome-vault`
- Used for demo content and safe editing tests
- It is okay to delete and recreate this vault
- It is the best place to test write workflows first

### External Obsidian vault

- Mounted from your host machine
- Usually bound at `/vaults/obsidian`
- This is your actual data
- Treat it as sensitive and back it up first

## Internal test vault vs Obsidian vault

Use the internal vault for:
- trying edit/create/rename flows
- checking Excalidraw behavior
- validating permission changes safely

Use the Obsidian vault for:
- your actual notes
- day-to-day reading once you trust the setup

Recommended default:
- demo test vault: `read-write`
- obsidian vault: `read-only`

## Mount the Obsidian vault read-only

This is the safest first step.

```yaml
volumes:
  - /absolute/host/path/to/your/vault:/vaults/obsidian:ro
```

And keep the vault mode in `mdvr.yaml` as:

```yaml
mode: read-only
```

## Mount the Obsidian vault read-write with warning

Only do this intentionally.

Requirements:
- auth enabled
- backups already tested
- you understand that the browser can write to your host files

Example:

```yaml
volumes:
  - /absolute/host/path/to/your/vault:/vaults/obsidian
```

Then switch the vault mode in `mdvr.yaml`:

```yaml
mode: read-write
```

Recommended extra guard:
- keep `delete: false`
- keep `server.write_without_auth: warn` only for demo-friendly setups; prefer `fail` when you want to block writes without auth
- keep Basic Auth enabled and change the default password

## Stop, update, remove

Stop the container:

```bash
docker compose down
```

Update after code or config changes:

```bash
docker compose up -d --build
```

Remove the container and network:

```bash
docker compose down
```

If you also want to remove local volume data, do that carefully and only after you know which volume is the demo vault and which volume is your real host data.

## Deleting the test vault is okay

The test vault is disposable.

The real vault is external host data.

Do not confuse the two.

## Backup recommendation

Before enabling write access to a real vault:
- make a copy of the vault
- verify restore from backup
- keep at least one backup outside the mdvr host

A browser-based write tool is convenient, but it is not a substitute for backups.

## Notes

- The public default should keep the Obsidian vault read-only.
- The demo vault should be the first thing users see.
- If you change ports, update the compose file and docs together.
