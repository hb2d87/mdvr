# OWS Obsidian Web Reader

A high-performance, containerized web interface for reading and managing local Obsidian vaults via a browser. Built with FastAPI and vanilla JavaScript, featuring an industrial Teenage Engineering K.O.II aesthetic, full multi-vault support, and deep customization options.

![OWS Obsidian Web Reader Demo](https://raw.githubusercontent.com/your-username/obsidian-web-reader/main/screenshot.png) <!-- Update with an actual screenshot -->

## Features

- **Blazing Fast SPA:** Native fetch API and vanilla JS for an ultra-lightweight client.
- **Multi-Vault Support:** Dynamically switch between multiple Obsidian vaults mounted via Docker.
- **Deep Customization:** 
  - 7 Built-in Theme Presets (K.O.II, Neon Cyberpunk, VS Code Dark+, etc.)
  - Change Typography, Text Size, and global UI color overrides in real-time.
- **Full File Management:** Create, Read, Update, Delete, and Rename your markdown and canvas notes directly in the browser.
- **Responsive Design:** Completely fluid interface with a mobile-optimized drawer sidebar.
- **Deep Links:** Open a note directly from a browser URL.

## Prerequisites

- Docker and Docker Compose installed on your host machine.

## Quick Start (Deployment)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/obsidian-web-reader.git
   cd obsidian-web-reader
   ```

2. **Connect your Vault:**
   To securely expose your Obsidian vaults to the reader, you need to mount them as a volume. 
   
   If using the CLI:
   ```bash
   docker build -t obsidian-reader .
   docker run -d \
     --name obsidian-web-reader \
     -p 3000:3000 \
     -v "/path/to/your/obsidian/vault:/vault" \
     obsidian-reader
   ```

   If you have multiple vaults inside a parent directory, simply mount the parent directory. OWS Obsidian Web Reader will automatically detect the subdirectories and let you switch between them dynamically in the Configuration menu.

3. **Access the Reader:**
   Open your browser and navigate to `http://localhost:3000` (or the port you mapped).

## Deep Links

Use the path-style route to open a specific note directly in reader mode:

```text
http://localhost:3000/obsidian/Research/note.md
```

For a multi-vault mount, include the optional `vault` query parameter:

```text
http://localhost:3000/obsidian/Research/note.md?vault=Work
```

The frontend still accepts `path`, `file`, and `note` query/hash aliases for backward compatibility, but `/obsidian/...` is now the canonical share format.

The file browser shows folders plus `.md` and `.canvas` files. Canvas notes currently open in the same raw-data preview/editor flow; full visual canvas rendering is not implemented in this build.

## Telegram / local-network sharing

When sharing a note link over Telegram, prefer the local network host used by the chat bridge:

```text
http://homeframe:3080/obsidian/Research/note.md
```

For clickable Telegram messages, format the link as Markdown:

```markdown
[Research/note.md](http://homeframe:3080/obsidian/Research/note.md)
```

To generate a link from a vault-relative path, use the helper:

```bash
python tools/ows_link.py "Research/note.md"
python tools/ows_link.py --vault Work "Research/note.md"
python tools/ows_link.py --raw "Research/note.md"
python tools/ows_link.py --style query "Research/note.md"
python tools/ows_link.py --style hash "Research/note.md"
```

`tools/ows_link.py` normalizes Windows separators, strips leading slashes, and emits a Telegram-friendly Markdown link using the slash-preserving path style by default. Vault targeting remains available via `--vault` for multi-vault setups.

## Configuration

Click the **Gear Icon** in the top navigation bar to open the Configuration menu. From here you can:
- Change the active vault (requires a parent folder with multiple vaults to be mounted).
- Select UI Themes, Font Families, and Font Sizes.
- Customize background and syntax highlighting colors.
All settings are stored locally in your browser (`localStorage`).

## Technical Stack

- **Backend:** Python 3.9, FastAPI, Uvicorn
- **Frontend:** Vanilla HTML/CSS/JS, Tailwind CSS (via CDN)
- **Containerization:** Docker, Nginx (for serving static assets and proxying API calls)

## License

MIT License
