---
name: draw
description: Draw Excalidraw diagrams via the Excalidraw Sidecar MCP server. Creates sessions, renders SVG, manages elements, and provides viewer links for browser-based editing.
---

# Excalidraw Sidecar MCP Skill

Draw diagrams using a remote MCP server. This skill wraps the MCP protocol and REST API into CLI commands via `mcp-client.mjs`.

## Deploy

The MCP server must be running before using this skill.

```bash
git clone https://github.com/anyin233/excalidraw-sidecar-mcp.git
cd excalidraw-sidecar-mcp
npm install && npm run build

# Single-domain deployment (recommended): serves MCP + viewer on one port
cd ../frontend && npm install && npm run build && cd ../excalidraw-mcp
node dist/index.js --static ../frontend/dist
# → MCP server + viewer on http://localhost:3001

# Or MCP-only (no frontend viewer):
npm run serve
# → MCP server on http://localhost:3001/mcp
```

With `--static`, viewer URLs in tool responses point to the same origin (e.g. `http://localhost:3001/view/<key>`), so users can open them directly without a separate frontend server.

For production deployment (Docker, nginx, systemd), see the [README](https://github.com/anyin233/excalidraw-sidecar-mcp#deploy).

## Configuration

The user MUST provide the server URL. Resolution order:

1. **Skill argument** — `/draw http://localhost:3001`
2. **Project config** — `.excalidraw-mcp.json` in the current working directory
3. **Home config** — `~/.excalidraw-mcp.json`

Config file format:
```json
{
  "server": "http://localhost:3001"
}
```

If no server URL is available, ask the user for it before proceeding.

## Helper Script

All commands use:
```
node <skill_dir>/scripts/mcp-client.mjs --server <url> <command> [args...]
```

Where `<skill_dir>` is the directory containing this SKILL.md file.

## Usage

### 1. Create a Session

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER create-session
```

Returns a session key (UUID) and viewer URL. Save the session key for all subsequent commands.

### 2. Get Element Format Reference

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER read-me
```

Call once per conversation. Returns the full element format reference with color palette, coordinate system, and examples.

### 3. Draw Elements

Write elements JSON to a temp file, then render:

```bash
cat > /tmp/elements.json << 'EOF'
[
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0},
  {"type":"rectangle","id":"r1","x":100,"y":100,"width":200,"height":100,
   "backgroundColor":"#a5d8ff","fillStyle":"solid","strokeColor":"#4a9eed","strokeWidth":2},
  {"type":"text","id":"t1","x":150,"y":140,"text":"Hello!","fontSize":20,"strokeColor":"#1e1e1e"}
]
EOF

node <skill_dir>/scripts/mcp-client.mjs --server $SERVER create-view <session_key> /tmp/elements.json
```

Response includes a checkpoint ID for incremental updates.

### 4. Get Current View

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER get-view <session_key>
```

Returns the latest SVG including any edits the user made in the browser viewer.

### 5. Update Elements (REST)

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER update-elements <session_key> /tmp/new-elements.json
```

Replaces all session elements via the REST API.

### 6. Delete Elements

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER delete-elements <session_key> id1,id2,id3
```

Fetches current elements, filters out the given IDs, PUTs the rest back.

### 7. Restore from Checkpoint

```bash
# Restore and add new elements
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER restore-checkpoint <session_key> <checkpoint_id> /tmp/extra.json

# Restore only
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER restore-checkpoint <session_key> <checkpoint_id>
```

### 8. Check Session Status

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER session-info <session_key>
```

## Key Points

- **Sessions expire after 24 hours.** Create a new one if expired.
- **Always call `read-me` once** before the first `create-view` to learn the element format.
- **Set viewport** with `cameraUpdate`: `{"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0}`
- **Use checkpoints** for incremental edits instead of re-sending all elements.
- **Assign stable `id` values** to elements so they can be deleted or referenced individually.
- **Share the viewer URL** — users can see and edit the diagram at `/view/<session_key>`. Use `get-view` to retrieve their edits.
- **Element ordering matters** — emit background shapes first, then per-node: shape, label, arrows.
- **Max input size:** 5 MB per `create-view` call.
