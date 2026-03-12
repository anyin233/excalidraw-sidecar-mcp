# Excalidraw Sidecar MCP

A remote MCP server that lets external LLMs create and manage Excalidraw diagrams over HTTP. Includes a browser-based viewer with live editing, server-side SVG rendering, and a CLI tool for scripted access.

![Demo](docs/demo.gif)

## Deploy

### Prerequisites

- Node.js 18+ (for native `fetch`)
- npm or pnpm

### Single-Domain Deployment (recommended)

Serve the MCP server, REST API, viewer pages, and frontend static files from a single port using the `--static` flag:

```bash
git clone https://github.com/anyin233/excalidraw-sidecar-mcp.git
cd excalidraw-sidecar-mcp
npm install && npm run build

# Build the frontend (from the parent project)
cd ../frontend && npm install && npm run build && cd ../excalidraw-mcp

# Start with --static pointing to the frontend dist
node dist/index.js --static ../frontend/dist
```

Everything runs on `http://localhost:3001`:

| Path | Description |
|------|-------------|
| `POST /mcp` | MCP Streamable HTTP endpoint |
| `/api/sessions/*` | REST API for session management |
| `/view/:key` | Viewer page (SPA, served from static files) |
| `/` | Landing page with server status and config |

When `--static` is used, `BASE_URL` is automatically set to the server's own origin, so viewer links in MCP tool responses point to the same domain. No separate frontend server needed.

### Multi-Port Development Setup

For development, run the MCP server and frontend dev server separately:

```bash
# Terminal 1: MCP server (no --static flag)
npm run serve

# Terminal 2: Frontend dev server (with Vite proxy to MCP server)
cd ../frontend && npm run dev
```

The Vite dev server at `http://localhost:5173` proxies `/api/sessions` and `/mcp` to port 3001 automatically (configured in `frontend/vite.config.ts`).

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | MCP server HTTP port |
| `BASE_URL` | auto (with `--static`) or `http://localhost:5173` | Base URL embedded in viewer links returned by MCP tools. Auto-set to `http://localhost:<PORT>` when `--static` is used. |

### Production

```bash
npm run build
cd ../frontend && npm run build && cd ../excalidraw-mcp

# Single-domain (recommended)
PORT=3001 node dist/index.js --static ../frontend/dist

# Or with explicit BASE_URL behind a reverse proxy
PORT=3001 BASE_URL=https://your-domain.com node dist/index.js --static ../frontend/dist
```

For process management, use PM2 or systemd:

```bash
# PM2
pm2 start dist/index.js --name excalidraw-mcp -- --static ../frontend/dist

# systemd (create /etc/systemd/system/excalidraw-mcp.service)
[Service]
ExecStart=/usr/bin/node /opt/excalidraw-sidecar-mcp/dist/index.js --static /opt/excalidraw-sidecar-mcp/frontend-dist
Environment=PORT=3001
Environment=BASE_URL=https://your-domain.com
Restart=always
```

### Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN npm install --production
COPY dist/ dist/
COPY frontend-dist/ frontend-dist/
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js", "--static", "frontend-dist"]
```

### Reverse Proxy (nginx)

With single-domain deployment, all routes are served by the same Node.js process:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_buffering off;           # Required for SSE streaming
        proxy_read_timeout 300s;
    }
}
```

---

## Usage

### Connect from Claude Desktop

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "excalidraw": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

Restart Claude Desktop. Then ask:

> "Draw an architecture diagram showing a load balancer routing to 3 microservices connected to a shared database"

Claude will call `create_session` → `read_me` → `create_view` and return an SVG image with a viewer link.

### Connect from Claude Desktop (stdio mode)

```json
{
  "mcpServers": {
    "excalidraw": {
      "command": "node",
      "args": ["/path/to/excalidraw-sidecar-mcp/dist/index.js", "--stdio"]
    }
  }
}
```

### Connect from Any MCP Client

Any client supporting [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) can connect to `http://<host>:3001/mcp`.

### CLI Tool

The included `skill/scripts/mcp-client.mjs` wraps the MCP protocol handshake into simple commands. Zero dependencies beyond Node.js 18+.

**Setup:**

```bash
# Option A: Pass server URL each time
node skill/scripts/mcp-client.mjs --server http://localhost:3001 <command>

# Option B: Create a config file (searched in cwd then home dir)
echo '{"server": "http://localhost:3001"}' > .excalidraw-mcp.json
node skill/scripts/mcp-client.mjs <command>
```

**Commands:**

```bash
# Create a 24h drawing session
node mcp-client.mjs create-session
# → Session key: "abc-123-..."
# → Viewer URL: http://localhost:5173/view/abc-123-...

# Get element format reference (call once before first draw)
node mcp-client.mjs read-me

# Draw elements from a JSON file
node mcp-client.mjs create-view <session_key> elements.json

# Draw elements from stdin
echo '[{"type":"rectangle","id":"r1","x":0,"y":0,"width":200,"height":100}]' \
  | node mcp-client.mjs create-view <session_key> -

# Get current view (includes user edits from browser)
node mcp-client.mjs get-view <session_key>

# Replace all elements via REST API
node mcp-client.mjs update-elements <session_key> new-elements.json

# Delete specific elements by ID
node mcp-client.mjs delete-elements <session_key> id1,id2,id3

# Restore from a checkpoint, optionally adding new elements
node mcp-client.mjs restore-checkpoint <session_key> <checkpoint_id> [extra.json]

# Check session status
node mcp-client.mjs session-info <session_key>
```

### Browser Viewer

Open the viewer URL returned by MCP tools (e.g. `http://localhost:3001/view/<session-key>` with single-domain deployment, or `http://localhost:5173/view/<session-key>` in dev mode):

- See the current diagram rendered as SVG
- **Pan** — click and drag to move around the diagram
- **Zoom** — scroll wheel to zoom in/out; percentage badge shown at bottom-right
- **Reset** — double-click to reset to fit-all view
- Click **Edit Diagram** to open the full Excalidraw editor
- Edit shapes, text, arrows interactively
- Changes sync back to the server automatically when you click **Done Editing**
- The page polls for external updates every 5 seconds

### Claude Code Skill

Copy the `skill/` directory into your Claude Code skills to get the `/draw` command:

```bash
cp -r skill/ /path/to/your/project/.claude/skills/draw/
```

Then use:

```
/draw http://localhost:3001
```

---

## MCP Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_session` | none | Create a 24h session. Returns session key + viewer URL |
| `read_me` | none | Element format cheat sheet with colors, coordinates, examples |
| `create_view` | `session_key`, `elements` (JSON string) | Render diagram. Returns SVG image + checkpoint ID |
| `get_current_view` | `session_key` | Get latest SVG including browser edits |

## REST API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/sessions/:key` | GET | Session metadata |
| `/api/sessions/:key/elements` | GET | Current elements array |
| `/api/sessions/:key/elements` | PUT | Replace elements |
| `/api/sessions/:key/svg` | GET | Rendered SVG image |

## Element Format

```json
[
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0},
  {"type":"rectangle","id":"box","x":100,"y":100,"width":200,"height":100,
   "backgroundColor":"#a5d8ff","fillStyle":"solid","strokeColor":"#4a9eed",
   "strokeWidth":2,"roundness":{"type":3}},
  {"type":"text","id":"label","x":150,"y":140,"text":"Hello","fontSize":20,
   "strokeColor":"#1e1e1e"},
  {"type":"arrow","id":"a1","x":300,"y":150,"width":100,"height":0,
   "points":[[0,0],[100,0]],"strokeColor":"#1e1e1e","endArrowhead":"arrow"}
]
```

Supported types: `rectangle`, `ellipse`, `diamond`, `text`, `arrow`. Use `cameraUpdate` to set viewport. Use `delete` and `restoreCheckpoint` pseudo-elements for incremental edits.

Call `read_me` for the full reference with color palette and examples.

## Credits

Built with [Excalidraw](https://github.com/excalidraw/excalidraw) and the [Model Context Protocol](https://modelcontextprotocol.io).

## License

MIT
