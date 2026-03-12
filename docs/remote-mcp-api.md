# Interactive Drawer — Remote MCP API Reference

The Interactive Drawer exposes a remote MCP server over Streamable HTTP transport, allowing external LLMs and scripts to create Excalidraw diagrams programmatically.

## Architecture

```
External LLM / Script ──MCP/HTTP──> Node.js (port 3001)
                                         ├── /mcp          MCP Streamable HTTP endpoint
                                         ├── Session Store  (in-memory, 24h TTL)
                                         ├── SVG Renderer   (JSDOM + exportToSvg)
                                         └── REST API       /api/sessions/*

User Browser ──────────────────────> Frontend (Vite, port 5173)
                                         ├── /              Chat + drawing app
                                         └── /view/:key     Session viewer page
```

## Quick Start

### 1. Start the Server

```bash
cd excalidraw-mcp
npm install
npm run serve
# Server starts on http://localhost:3001
```

### 2. Create a Session

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "my-client", "version": "1.0.0" }
    },
    "id": 1
  }'
```

Save the `mcp-session-id` header from the response, then send:

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id>" \
  -d '[
    { "jsonrpc": "2.0", "method": "notifications/initialized" },
    { "jsonrpc": "2.0", "method": "tools/call",
      "params": { "name": "create_session", "arguments": {} }, "id": 2 }
  ]'
```

### 3. Draw a Diagram

Use the session key from step 2:

```bash
curl -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{...initialize...}' # (same initialize + tool call pattern)
```

Tool call payload:
```json
{
  "name": "create_view",
  "arguments": {
    "session_key": "<session-key>",
    "elements": "[{\"type\":\"rectangle\",\"id\":\"r1\",\"x\":100,\"y\":100,\"width\":200,\"height\":100}]"
  }
}
```

### 4. Open the Viewer

Navigate to `http://localhost:5173/view/<session-key>` in a browser to see the diagram and edit it interactively.

### Using the CLI Helper (Recommended)

The `skill/scripts/mcp-client.mjs` script simplifies the MCP handshake:

```bash
# Create session
node skill/scripts/mcp-client.mjs --server http://localhost:3001 create-session

# Draw elements
node skill/scripts/mcp-client.mjs --server http://localhost:3001 create-view <key> elements.json

# Get current view
node skill/scripts/mcp-client.mjs --server http://localhost:3001 get-view <key>
```

---

## MCP Tools Reference

The MCP endpoint is `POST /mcp`. All tool calls use the MCP Streamable HTTP protocol (initialize → notifications/initialized → tools/call).

### create_session

Create a new 24-hour drawing session.

**Parameters:** None

**Response:**
```
Session created!
Session key: "<uuid>"
Viewer URL: http://localhost:5173/view/<uuid>
Expires at: 2026-03-14T12:00:00.000Z
```

### read_me

Returns the Excalidraw element format reference with color palettes, coordinate tips, and examples.

**Parameters:** None

**Response:** Full cheat sheet text (~400 lines). Call once per conversation before the first `create_view`.

### create_view

Render a diagram from Excalidraw elements. Returns SVG image + viewer link.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `session_key` | string | Yes | Session key from `create_session` |
| `elements` | string | Yes | JSON array of Excalidraw elements (stringified) |

**Response content:**
1. `TextContent` — Checkpoint ID, viewer URL, usage instructions
2. `ImageContent` — SVG as base64 with `mimeType: "image/svg+xml"`

**Element format highlights:**

```json
[
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0},
  {"type":"rectangle","id":"r1","x":100,"y":100,"width":200,"height":100,
   "backgroundColor":"#a5d8ff","fillStyle":"solid",
   "strokeColor":"#4a9eed","strokeWidth":2,"roundness":{"type":3}},
  {"type":"text","id":"t1","x":130,"y":140,"text":"Hello","fontSize":20,
   "strokeColor":"#1e1e1e"}
]
```

**Supported element types:** `rectangle`, `ellipse`, `diamond`, `text`, `arrow`

**Pseudo-elements (not rendered, control behavior):**
- `cameraUpdate` — Set viewport: `{"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0}`
- `delete` — Remove elements: `{"type":"delete","ids":"id1,id2"}`
- `restoreCheckpoint` — Restore state: `{"type":"restoreCheckpoint","id":"<checkpoint_id>"}`

**Errors:**
- Session not found or expired → `isError: true`
- Invalid JSON → `isError: true` with parse error message
- Input exceeds 5 MB limit → `isError: true`

### get_current_view

Get the latest diagram view, including user edits made via the browser viewer.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `session_key` | string | Yes | Session key from `create_session` |

**Response content:**
1. `TextContent` — Viewer URL
2. `ImageContent` — Current SVG as base64

---

## REST API Reference

REST endpoints are available at `http://localhost:3001/api/sessions/`. These are used by the frontend viewer page and can be called directly for element management.

### GET /api/sessions/:key

Get session metadata.

**Response (200):**
```json
{
  "sessionKey": "dd9c4dec-60e4-4bc6-ba99-95264c0626cd",
  "expiresAt": "2026-03-14T12:00:00.000Z",
  "hasElements": true
}
```

**Errors:**
- `404` — Session not found or expired
- `400` — Invalid session key format (not a valid UUID)

### GET /api/sessions/:key/elements

Get the current elements array.

**Response (200):**
```json
{
  "elements": [
    {"type":"rectangle","id":"r1","x":100,"y":100,"width":200,"height":100, ...},
    ...
  ]
}
```

### PUT /api/sessions/:key/elements

Replace all elements in a session. Used by the viewer page to sync user edits.

**Request body:**
```json
{
  "elements": [ ... ]
}
```

**Response (200):**
```json
{ "ok": true }
```

**Errors:**
- `400` — Missing or invalid `elements` array
- `404` — Session not found or expired

### GET /api/sessions/:key/svg

Get the rendered SVG image.

**Response (200):** SVG content with `Content-Type: image/svg+xml`

**Errors:**
- `404` — Session not found or has no diagram yet
- `500` — SVG rendering failed

---

## Configuration

### Server

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `PORT` | `3001` | HTTP server port |
| `BASE_URL` | `http://localhost:5173` | Base URL for viewer links in MCP responses |

### CLI Helper Config

The `mcp-client.mjs` script resolves the server URL in this order:

1. `--server <url>` flag
2. `.excalidraw-mcp.json` in the current working directory
3. `~/.excalidraw-mcp.json` in the home directory

Config file format:
```json
{
  "server": "http://localhost:3001",
  "defaultWidth": 800,
  "defaultHeight": 600
}
```

---

## Element Format Quick Reference

### Shapes

```json
{"type":"rectangle","id":"r1","x":0,"y":0,"width":200,"height":100,
 "backgroundColor":"#a5d8ff","fillStyle":"solid",
 "strokeColor":"#4a9eed","strokeWidth":2,
 "roundness":{"type":3}}

{"type":"ellipse","id":"e1","x":0,"y":0,"width":200,"height":100,
 "backgroundColor":"#d0bfff","fillStyle":"solid",
 "strokeColor":"#8b5cf6","strokeWidth":2}

{"type":"diamond","id":"d1","x":0,"y":0,"width":150,"height":100,
 "backgroundColor":"#ffc9c9","fillStyle":"solid",
 "strokeColor":"#ef4444","strokeWidth":2}
```

### Text

```json
{"type":"text","id":"t1","x":50,"y":50,
 "text":"Hello World","fontSize":20,
 "strokeColor":"#1e1e1e"}
```

Multi-line text: use `\n` in the `text` field.

### Arrows

```json
{"type":"arrow","id":"a1","x":100,"y":100,
 "width":200,"height":0,
 "points":[[0,0],[200,0]],
 "strokeColor":"#1e1e1e","strokeWidth":2,
 "endArrowhead":"arrow"}
```

Arrow points are relative to `(x, y)`. Set `strokeStyle: "dashed"` for dashed lines.

### Color Palette

| Color | Hex | Pastel Fill |
|-------|-----|-------------|
| Blue | `#4a9eed` | `#a5d8ff` |
| Amber | `#f59e0b` | `#fff3bf` |
| Green | `#22c55e` | `#c3fae8` |
| Red | `#ef4444` | `#ffc9c9` |
| Purple | `#8b5cf6` | `#d0bfff` |

### Camera (Viewport)

```json
{"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0}
```

---

## Examples

### Node.js Script

```javascript
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3001";

async function mcpCall(method, params = {}) {
  const initRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "example", version: "1.0.0" },
      },
      id: 1,
    }),
  });

  const sessionId = initRes.headers.get("mcp-session-id");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const callRes = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method, params, id: 2 },
    ]),
  });

  const text = await callRes.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (parsed.id === 2) return parsed;
      } catch {}
    }
  }
}

// Create session
const sr = await mcpCall("tools/call", { name: "create_session", arguments: {} });
const sessionKey = sr.result.content[0].text.match(/Session key: "([^"]+)"/)[1];
console.log("Session:", sessionKey);

// Draw a rectangle with label
const elements = JSON.stringify([
  { type: "cameraUpdate", width: 400, height: 300, x: 0, y: 0 },
  { type: "rectangle", id: "box", x: 50, y: 50, width: 300, height: 200,
    backgroundColor: "#a5d8ff", fillStyle: "solid", strokeColor: "#4a9eed" },
  { type: "text", id: "label", x: 120, y: 140, text: "My Diagram",
    fontSize: 24, strokeColor: "#1e1e1e" },
]);

const vr = await mcpCall("tools/call", {
  name: "create_view",
  arguments: { session_key: sessionKey, elements },
});
console.log(vr.result.content[0].text);
```

### CLI Helper Script

```bash
# Setup config (one-time)
echo '{"server": "http://localhost:3001"}' > .excalidraw-mcp.json

# Full workflow
SESSION=$(node skill/scripts/mcp-client.mjs create-session 2>&1 | grep 'Session key' | sed 's/.*"\(.*\)".*/\1/')

cat > /tmp/diagram.json << 'EOF'
[
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0},
  {"type":"rectangle","id":"server","x":300,"y":200,"width":200,"height":120,
   "backgroundColor":"#a5d8ff","fillStyle":"solid","strokeColor":"#4a9eed","strokeWidth":2,
   "roundness":{"type":3}},
  {"type":"text","id":"server_label","x":350,"y":250,"text":"Server","fontSize":20,
   "strokeColor":"#4a9eed"}
]
EOF

node skill/scripts/mcp-client.mjs create-view "$SESSION" /tmp/diagram.json

# Check for user edits later
node skill/scripts/mcp-client.mjs get-view "$SESSION"

# Delete an element
node skill/scripts/mcp-client.mjs delete-elements "$SESSION" server_label

# Get session info
node skill/scripts/mcp-client.mjs session-info "$SESSION"
```

### Claude Desktop Configuration

To use with Claude Desktop as a remote MCP server:

```json
{
  "mcpServers": {
    "interactive-drawer": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```
