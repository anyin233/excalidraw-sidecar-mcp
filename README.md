# Excalidraw Sidecar MCP

A remote MCP server that lets external LLMs create and manage Excalidraw diagrams over HTTP. Includes a browser-based viewer with live editing, server-side SVG rendering, and a CLI tool for scripted access.

![Demo](docs/demo.gif)

## Deploy

### Prerequisites

- Node.js 18+ (for native `fetch`)
- npm or pnpm

### Local

```bash
git clone https://github.com/anyin233/excalidraw-sidecar-mcp.git
cd excalidraw-sidecar-mcp
npm install
npm run serve
```

The MCP server starts on `http://localhost:3001/mcp`.

To also run the frontend viewer (for `/view/:sessionKey` pages):

```bash
# Terminal 1: MCP server
npm run serve

# Terminal 2: Frontend (requires the interactive_drawer frontend)
cd ../frontend && npm install && npm run dev
```

The viewer is then available at `http://localhost:5173/view/<session-key>`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | MCP server HTTP port |
| `BASE_URL` | `http://localhost:5173` | Base URL embedded in viewer links returned by MCP tools |

### Production

```bash
npm run build
PORT=3001 BASE_URL=https://your-domain.com node dist/index.js
```

For process management, use PM2 or systemd:

```bash
# PM2
pm2 start dist/index.js --name excalidraw-mcp -- --port 3001

# systemd (create /etc/systemd/system/excalidraw-mcp.service)
[Service]
ExecStart=/usr/bin/node /opt/excalidraw-sidecar-mcp/dist/index.js
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
ENV PORT=3001
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

### Reverse Proxy (nginx)

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;           # Required for SSE streaming
    proxy_read_timeout 300s;
}

location /api/sessions {
    proxy_pass http://127.0.0.1:3001;
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

Open `http://localhost:5173/view/<session-key>` to:

- See the current diagram rendered as SVG
- Click **Edit Diagram** to open the Excalidraw editor
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
