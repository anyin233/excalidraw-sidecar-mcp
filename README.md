# Excalidraw Sidecar MCP

A remote MCP server that lets external LLMs create and manage Excalidraw diagrams over HTTP. Provides session-based drawing with server-side SVG rendering, a browser viewer for live editing, and a CLI skill for Claude Code integration.

![Demo](docs/demo.gif)

## Features

- **Remote MCP Server** — Streamable HTTP transport at `/mcp`, compatible with Claude Desktop and any MCP client
- **Session Management** — 24-hour drawing sessions with in-memory store, create/view/edit/delete via 4 MCP tools
- **Server-Side SVG Rendering** — JSDOM + Excalidraw `exportToSvg` with automatic fallback renderer
- **Browser Viewer** — Live viewer page at `/view/:sessionKey` with fullscreen Excalidraw editor, auto-polling for external updates
- **REST API** — CRUD endpoints for session elements (`GET/PUT /api/sessions/:key/elements`)
- **Checkpoint System** — Incremental diagram updates via `restoreCheckpoint` pseudo-elements
- **CLI Helper** — Zero-dependency Node.js script wrapping the full MCP protocol handshake
- **Claude Code Skill** — `/draw` skill with 9-step workflow for drawing from any project

## Quick Start

### 1. Start the Server

```bash
git clone https://github.com/anyin233/excalidraw-sidecar-mcp.git
cd excalidraw-sidecar-mcp
npm install
npm run serve
# MCP server listening on http://localhost:3001/mcp
```

### 2. Create a Session and Draw

Using the CLI helper:

```bash
node skill/scripts/mcp-client.mjs --server http://localhost:3001 create-session
# → Session key: "abc-123-..."

node skill/scripts/mcp-client.mjs --server http://localhost:3001 create-view abc-123-... elements.json
# → Diagram rendered! Viewer URL: http://localhost:5173/view/abc-123-...
```

Or configure Claude Desktop:

```json
{
  "mcpServers": {
    "interactive-drawer": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Then ask Claude: *"Draw an architecture diagram showing microservices communicating via a message queue"*

### 3. View and Edit

Open the viewer URL in your browser. Edit the diagram with the built-in Excalidraw editor — changes sync back to the server automatically.

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_session` | Create a new 24h drawing session, returns session key + viewer URL |
| `read_me` | Element format reference with color palettes, coordinates, and examples |
| `create_view` | Render diagram from Excalidraw JSON, returns SVG image + checkpoint ID |
| `get_current_view` | Get latest SVG including user edits from the browser viewer |

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:key` | GET | Session metadata (existence, expiry) |
| `/api/sessions/:key/elements` | GET | Current elements array |
| `/api/sessions/:key/elements` | PUT | Replace elements (user edits) |
| `/api/sessions/:key/svg` | GET | Rendered SVG image |

## CLI Helper

`skill/scripts/mcp-client.mjs` — zero-dependency Node.js script (requires Node 18+ for native `fetch`).

```bash
# Configuration: pass --server flag or create .excalidraw-mcp.json
echo '{"server": "http://localhost:3001"}' > .excalidraw-mcp.json

# Commands
node skill/scripts/mcp-client.mjs create-session
node skill/scripts/mcp-client.mjs create-view <key> <file.json | ->
node skill/scripts/mcp-client.mjs get-view <key>
node skill/scripts/mcp-client.mjs update-elements <key> <file.json | ->
node skill/scripts/mcp-client.mjs delete-elements <key> <id1,id2,...>
node skill/scripts/mcp-client.mjs restore-checkpoint <key> <checkpoint_id> [file.json]
node skill/scripts/mcp-client.mjs session-info <key>
node skill/scripts/mcp-client.mjs read-me
```

Supports file input, stdin (`-`), and piped JSON.

## Claude Code Skill

Install the `/draw` skill for Claude Code by copying the `skill/` directory into your project or linking it:

```bash
# From your project
cp -r /path/to/excalidraw-sidecar-mcp/skill .claude/skills/draw
```

Then invoke with:
```
/draw http://localhost:3001
```

## Architecture

```
External LLM ──MCP/HTTP──> Node.js (port 3001)
                                ├── /mcp             Streamable HTTP endpoint
                                ├── Session Store    In-memory, 24h TTL, 100 max
                                ├── SVG Renderer     JSDOM + exportToSvg + fallback
                                └── REST API         /api/sessions/*

Browser ───────────────────> Frontend (Vite, port 5173)
                                ├── /                Chat + drawing app
                                └── /view/:key       Session viewer + editor
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `BASE_URL` | `http://localhost:5173` | Base URL for viewer links in responses |

## Documentation

- [Remote MCP API Reference](docs/remote-mcp-api.md) — Full API docs with examples
- [Skill Definition](skill/SKILL.md) — Claude Code skill workflow
- [Config Example](skill/config.example.json) — CLI configuration template

## Running Modes

```bash
# HTTP mode (default) — remote MCP server with sessions
npm run serve

# stdio mode — for Claude Desktop local integration
node dist/index.js --stdio

# Dev mode — watch + serve
npm run dev
```

## Credits

Built with [Excalidraw](https://github.com/excalidraw/excalidraw) and the [Model Context Protocol](https://modelcontextprotocol.io).

## License

MIT
