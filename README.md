# Markdown Vault Reader (mdvr)

A high-performance, containerized web interface for reading and managing local markdown and excalidraw files vaults via a browser. Built with FastAPI and vanilla JavaScript.

## Features

- **Fast SPA:** Native fetch API and vanilla JS for an ultra-lightweight client.
- **Multi-Vault Support:** Dynamically switch between multiple vaults mounted via Docker.
- **Some Customization:** 
  - Theme Presets
  - Change Typography, Text Size, and global UI color overrides.
- **File Management:** Create, Read, Update, Delete, and Rename your files directly in the browser.
- **Responsive Design:** Somewhat fluid interface with a mobile-optimized drawer sidebar.

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

   If you have multiple vaults inside a parent directory, simply mount the parent directory. mdvr will automatically detect the subdirectories and let you switch between them dynamically in the Configuration menu.

3. **Access the Reader:**
   Open your browser and navigate to `http://localhost:3000` (or the port you mapped).

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
