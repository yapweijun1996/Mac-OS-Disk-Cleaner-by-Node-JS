# Mac-OS-Disk-Cleaner-by-Node-JS

A safe, user-friendly tool for cleaning up disk space on macOS by identifying and removing large or old files from caches, downloads, and development directories. Features a web-based UI for easy selection and a CLI script for automation.

## Features

- **Safe by Design**: HOME-scoped operations, deny-lists sensitive directories (Photos, Mail, Desktop, Documents), Trash by default, dry-run mode.
- **Multiple Interfaces**: Web UI for interactive use, CLI script for automation.
- **Categories**: Scans user-caches, browsers, dev tools, package managers, downloads, docker, deep (advanced caches).
- **Filtering**: By size (>= 50MB default), age (>= 30 days default), categories.
- **Apply Modes**: Move to Trash (default) or permanent delete with confirmation.
- **No External Dependencies**: Uses built-in Node.js modules and Bash.

## Requirements

- **Node.js** (for server and UI backend)
- **Bash** (for CLI script)
- **macOS** (optimized for macOS file system and directories)
- Optional: **Python** (for --serve mode in CLI)

## Installation

1. Clone or download the repository:
   ```bash
   git clone https://github.com/yapweijun/Mac-OS-Disk-Cleaner-by-Node-JS.git
   cd Mac-OS-Disk-Cleaner-by-Node-JS
   ```

2. Ensure scripts are executable:
   ```bash
   chmod +x disk_cleaner.sh
   ```

## Usage

### Quick Start (Easiest)

Run the one-click mode with safe defaults:
```bash
./disk_cleaner.sh --easy
```
This generates a scan report, starts a local web server, and opens the UI in your browser.

### CLI Mode

#### Scan and Generate Report
```bash
# Basic scan with defaults (50MB+, 30 days+, caches/dev/pkg)
./disk_cleaner.sh --scan-output /tmp/report.json

# Custom scan
./disk_cleaner.sh --scan-output /tmp/report.json --min-size 100M --older-than 60 --include downloads --exclude dev

# Auto-save to Downloads
./disk_cleaner.sh --scan-to-downloads
```

#### Apply Cleanup Plan
```bash
# Dry-run first (recommended)
./disk_cleaner.sh --apply-from /path/to/plan.json --dry-run

# Apply with Trash (safe)
./disk_cleaner.sh --apply-from /path/to/plan.json --apply --trash --yes

# Permanent delete (dangerous, requires confirmation)
./disk_cleaner.sh --apply-from /path/to/plan.json --apply --no-trash --yes
```

### Web UI Mode

1. Start the Node.js server:
   ```bash
   node server.js
   ```
   Server runs on http://localhost:8765

2. Open http://localhost:8765/index.html in a browser.

3. The UI auto-detects the backend and can perform scans directly.

4. Load a scan report JSON, filter/select items, export a cleanup plan, then apply via CLI or UI.

### Serve Mode (Combined)

```bash
# Serve UI with auto-generated report
./disk_cleaner.sh --serve --min-size 50M --older-than 30 --downloads
```
Opens browser with auto-loaded report.

## API (For Developers)

The Node.js server provides REST endpoints:

- `GET /api/ping` → `{ ok: true, ts: "ISO8601" }`
- `GET /api/scan?minSize=bytes&olderThan=days&include=cats&exclude=cats&downloads=1` → Scan report JSON
- `POST /api/apply?dryRun=1&mode=trash|delete` → Apply plan JSON body

Static files served from current directory.

## Safety Notes

- **HOME-Scoped**: Only scans within user's home directory.
- **Deny-Listed**: Skips Photos, Mail, iCloud Documents, Desktop, Documents.
- **Trash Default**: Moves files to ~/.Trash instead of deleting.
- **Dry-Run**: Always test with --dry-run first.
- **Confirmation**: Permanent delete requires --yes flag.
- **Logging**: Actions logged to ~/Library/Logs/disk_cleaner.log

## Development

### Project Structure

- `disk_cleaner.sh`: Bash CLI script for scanning/applying.
- `server.js`: Node.js HTTP server (no deps).
- `index.html`: Web UI HTML.
- `script.js`: Client-side JavaScript for UI logic.
- `styles.css`: UI styling.

### Extending

- Add new categories in `disk_cleaner.sh` collect functions and server.js scanHandler.
- Modify deny-list in `isDenyListed` functions.
- UI components in `script.js` and `index.html`.

### Testing

- Use --dry-run for safe testing.
- Check logs for errors.
- Test on macOS only (uses macOS-specific paths and commands).

## License

MIT License (assumed; check repository for details).