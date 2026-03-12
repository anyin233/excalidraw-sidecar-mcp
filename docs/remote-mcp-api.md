# Remote MCP API Reference

Excalidraw Sidecar MCP 服务器的完整 API 参考。覆盖 MCP 协议握手、四个 MCP 工具、REST API 端点和 Excalidraw 元素格式。部署说明见 [DEPLOYMENT.md](../../DEPLOYMENT.md)。

---

## MCP Protocol

The server uses [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport. All tool calls require a three-step handshake:

1. **Initialize** — `POST /mcp` with `method: "initialize"`
2. **Notify + Call** — `POST /mcp` (batched) with `notifications/initialized` + `tools/call`
3. **Parse SSE** — Response is Server-Sent Events; extract `data:` lines as JSON

The CLI tool at `skill/scripts/mcp-client.mjs` handles this automatically.

### Raw Protocol Example

```bash
# Step 1: Initialize (save the mcp-session-id header)
curl -s -D- -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": {"name": "my-client", "version": "1.0"}
    },
    "id": 1
  }'

# Step 2: Tool call (use mcp-session-id from step 1)
curl -s -X POST http://localhost:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: <session-id-from-step-1>" \
  -d '[
    {"jsonrpc":"2.0","method":"notifications/initialized"},
    {"jsonrpc":"2.0","method":"tools/call",
     "params":{"name":"create_session","arguments":{}}, "id":2}
  ]'
```

---

## MCP Tools

### create_session

Create a new drawing session with 24-hour TTL. Maximum 100 concurrent sessions.

**Parameters:** None

**Returns:** Text with session key, viewer URL, and expiry timestamp.

```
Session created!
Session key: "dd9c4dec-60e4-4bc6-ba99-95264c0626cd"
Viewer URL: http://localhost:3001/view/dd9c4dec-60e4-4bc6-ba99-95264c0626cd
Expires at: 2026-03-14T12:00:00.000Z
```

(The viewer URL points to the MCP server itself when using `--static` single-domain deployment. In multi-port dev mode with Vite, it defaults to `http://localhost:5173`.)

**CLI:**
```bash
node mcp-client.mjs --server http://localhost:3001 create-session
```

---

### read_me

Returns the Excalidraw element format reference (~400 lines). Includes color palette, element types, coordinate system, and annotated examples.

**Parameters:** None

**Returns:** Text cheat sheet. Call once before the first `create_view` in a conversation.

**CLI:**
```bash
node mcp-client.mjs --server http://localhost:3001 read-me
```

---

### create_view

Render a diagram from Excalidraw elements. Stores elements in the session, saves a checkpoint, renders SVG server-side, and returns the image.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `session_key` | string | UUID from `create_session` |
| `elements` | string | JSON array of Excalidraw elements (stringified) |

**Returns:**
1. **TextContent** — Checkpoint ID, viewer URL, and instructions for incremental edits
2. **ImageContent** — SVG as base64 (`mimeType: "image/svg+xml"`)

**Element JSON structure:**

```json
[
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0},
  {"type":"rectangle","id":"r1","x":100,"y":100,"width":200,"height":100,
   "backgroundColor":"#a5d8ff","fillStyle":"solid",
   "strokeColor":"#4a9eed","strokeWidth":2,"roundness":{"type":3}},
  {"type":"text","id":"t1","x":130,"y":140,"text":"My Box",
   "fontSize":20,"strokeColor":"#1e1e1e"}
]
```

**Pseudo-elements** (control behavior, not rendered):

| Type | Fields | Purpose |
|------|--------|---------|
| `cameraUpdate` | `width`, `height`, `x`, `y` | Set the SVG viewport |
| `delete` | `ids` (comma-separated) | Remove elements by ID |
| `restoreCheckpoint` | `id` (checkpoint ID) | Restore previous state before applying new elements |

**Incremental editing** — use the checkpoint ID from the response:

```json
[
  {"type":"restoreCheckpoint","id":"c5235f15180b40aba6"},
  {"type":"delete","ids":"old_element_1,old_element_2"},
  {"type":"rectangle","id":"new_box","x":50,"y":50,"width":150,"height":80}
]
```

**Errors:**
- Session not found or expired
- Invalid JSON (parse error details included)
- Input exceeds 5 MB

**CLI:**
```bash
# From file
node mcp-client.mjs --server http://localhost:3001 create-view <key> elements.json

# From stdin
echo '[...]' | node mcp-client.mjs --server http://localhost:3001 create-view <key> -
```

---

### get_current_view

Get the latest diagram for a session. If the user edited the diagram in the browser viewer, this returns their updated version.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `session_key` | string | UUID from `create_session` |

**Returns:**
1. **TextContent** — Viewer URL
2. **ImageContent** — Current SVG as base64

SVG is cached and only re-rendered when elements change.

**CLI:**
```bash
node mcp-client.mjs --server http://localhost:3001 get-view <key>
```

---

## REST API

REST endpoints run on the same port as the MCP server. Used by the browser viewer and available for direct integration.

### GET /api/sessions/:key

Session metadata.

**Response `200`:**
```json
{
  "sessionKey": "dd9c4dec-60e4-4bc6-ba99-95264c0626cd",
  "expiresAt": "2026-03-14T12:00:00.000Z",
  "hasElements": true
}
```

**Errors:** `400` invalid UUID format, `404` not found or expired.

**CLI:**
```bash
node mcp-client.mjs --server http://localhost:3001 session-info <key>
```

---

### GET /api/sessions/:key/elements

Current elements array.

**Response `200`:**
```json
{
  "elements": [
    {"type":"rectangle","id":"r1","x":100,"y":100,"width":200,"height":100, ...},
    {"type":"text","id":"t1","x":130,"y":140,"text":"My Box", ...}
  ]
}
```

---

### PUT /api/sessions/:key/elements

Replace all elements in a session. Invalidates SVG cache.

**Request:**
```json
{
  "elements": [ ... ]
}
```

**Response `200`:**
```json
{"ok": true}
```

**Errors:** `400` missing `elements` array, `404` session not found.

**CLI:**
```bash
# Replace all elements
node mcp-client.mjs --server http://localhost:3001 update-elements <key> new.json

# Delete specific elements (fetches, filters, PUTs back)
node mcp-client.mjs --server http://localhost:3001 delete-elements <key> id1,id2
```

---

### GET /api/sessions/:key/svg

Rendered SVG image. Returns cached version or re-renders if cache is invalidated.

**Response `200`:** SVG content (`Content-Type: image/svg+xml`)

**Errors:** `404` no diagram yet, `500` rendering failed.

```bash
# Download SVG
curl -o diagram.svg http://localhost:3001/api/sessions/<key>/svg

# Embed in HTML
<img src="http://localhost:3001/api/sessions/<key>/svg" alt="diagram" />
```

---

## Element Format Quick Reference

### Shapes

| Type | Required Fields | Optional |
|------|----------------|----------|
| `rectangle` | `id`, `x`, `y`, `width`, `height` | `backgroundColor`, `fillStyle`, `strokeColor`, `strokeWidth`, `roundness`, `opacity` |
| `ellipse` | `id`, `x`, `y`, `width`, `height` | same as rectangle |
| `diamond` | `id`, `x`, `y`, `width`, `height` | same as rectangle |
| `text` | `id`, `x`, `y`, `text` | `fontSize`, `strokeColor`, `textAlign` |
| `arrow` | `id`, `x`, `y`, `points` | `strokeColor`, `strokeWidth`, `strokeStyle`, `endArrowhead`, `startArrowhead` |

### Color Palette

| Color | Stroke | Fill |
|-------|--------|------|
| Blue | `#4a9eed` | `#a5d8ff` |
| Amber | `#f59e0b` | `#fff3bf` |
| Green | `#22c55e` | `#c3fae8` |
| Red | `#ef4444` | `#ffc9c9` |
| Purple | `#8b5cf6` | `#d0bfff` |
| Pink | `#ec4899` | `#fcc2d7` |
| Cyan | `#06b6d4` | `#99e9f2` |

### Arrow Points

Points are relative to `(x, y)`:

```json
{"type":"arrow","id":"a1","x":100,"y":100,
 "width":200,"height":50,
 "points":[[0,0],[100,25],[200,50]],
 "strokeColor":"#1e1e1e","strokeWidth":2,
 "endArrowhead":"arrow"}
```

### Multi-line Text

Use `\n` in the `text` field:

```json
{"type":"text","id":"t1","x":50,"y":50,
 "text":"Line 1\nLine 2\nLine 3","fontSize":16}
```

---

## Usage Examples

### CLI: Scripted Pipeline

```bash
#!/bin/bash
SERVER="http://localhost:3001"
CLI="node skill/scripts/mcp-client.mjs --server $SERVER"

# Create session and extract key
OUTPUT=$($CLI create-session)
KEY=$(echo "$OUTPUT" | grep 'Session key' | sed 's/.*"\(.*\)".*/\1/')
echo "Session: $KEY"

# Draw from file
$CLI create-view "$KEY" my-diagram.json

# Wait for user to edit in browser...
read -p "Press enter after editing in the viewer..."

# Fetch updated diagram
$CLI get-view "$KEY"

# Download SVG
curl -s "$SERVER/api/sessions/$KEY/svg" -o updated-diagram.svg
```
