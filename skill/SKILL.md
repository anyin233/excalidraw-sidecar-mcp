---
name: draw
description: Draw Excalidraw diagrams via the Interactive Drawer remote MCP server. Creates sessions, renders SVG, manages elements, and provides viewer links for browser-based editing.
---

# Interactive Drawer MCP Skill

Draw diagrams using the Interactive Drawer remote MCP server. This skill wraps the MCP protocol and REST API into simple CLI commands.

## Prerequisites

The Interactive Drawer MCP server must be running. The user MUST provide the server URL either:
1. As a skill argument: `/draw http://localhost:3001`
2. Via a config file: `.excalidraw-mcp.json` in the project root or `~/.excalidraw-mcp.json`

If no server URL is available, ask the user for it before proceeding.

## Configuration

Check for the server URL in this order:
1. **Skill argument** — the first argument to `/draw` is the server URL
2. **Project config** — `.excalidraw-mcp.json` in the current working directory
3. **Home config** — `~/.excalidraw-mcp.json`

Config file format:
```json
{
  "server": "http://localhost:3001"
}
```

## Helper Script

All commands use the helper script at:
```
<skill_dir>/scripts/mcp-client.mjs
```

Where `<skill_dir>` is the directory containing this SKILL.md file. Use `node <skill_dir>/scripts/mcp-client.mjs` to invoke it.

The `--server <url>` flag is always passed explicitly to the script. If the user provided a URL as the skill argument, use that. Otherwise, read it from the config file. If neither is available, ask the user.

## Workflow

### Step 1: Resolve Server URL

```bash
# From skill argument
SERVER="<url from /draw argument>"

# Or from config file
SERVER=$(node -e "const f=require('fs'),p=require('path'); \
  const c=['.excalidraw-mcp.json',p.join(require('os').homedir(),'.excalidraw-mcp.json')]; \
  for(const x of c){try{console.log(JSON.parse(f.readFileSync(x,'utf-8')).server);process.exit(0)}catch{}} \
  console.error('No config found');process.exit(1)")
```

### Step 2: Create a Session

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER create-session
```

This returns a session key and viewer URL. Save the session key for subsequent commands.

### Step 3: Get Element Format Reference (First Time)

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER read-me
```

Read this once per conversation to understand the Excalidraw element format, color palette, and coordinate system.

### Step 4: Draw Elements

Write the elements JSON to a temporary file, then call create-view:

```bash
# Write elements to a temp file
cat > /tmp/elements.json << 'ELEMENTS_EOF'
[
  {"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0},
  {"type":"rectangle","id":"r1","x":100,"y":100,"width":200,"height":100,
   "backgroundColor":"#a5d8ff","fillStyle":"solid","strokeColor":"#4a9eed","strokeWidth":2},
  {"type":"text","id":"t1","x":150,"y":140,"text":"Hello!","fontSize":20,"strokeColor":"#1e1e1e"}
]
ELEMENTS_EOF

node <skill_dir>/scripts/mcp-client.mjs --server $SERVER create-view <session_key> /tmp/elements.json
```

The response includes a checkpoint ID for incremental updates.

### Step 5: Get Current View (After User Edits)

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER get-view <session_key>
```

Returns the current SVG including any edits the user made in the browser viewer.

### Step 6: Update Elements Directly (REST API)

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER update-elements <session_key> /tmp/new-elements.json
```

Replaces all session elements. Useful for syncing programmatic changes.

### Step 7: Delete Specific Elements

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER delete-elements <session_key> id1,id2,id3
```

Removes elements by their IDs and PUTs the filtered list back.

### Step 8: Restore from Checkpoint

```bash
# Restore checkpoint and add new elements on top
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER restore-checkpoint <session_key> <checkpoint_id> /tmp/additional.json

# Restore checkpoint only (no additions)
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER restore-checkpoint <session_key> <checkpoint_id>
```

### Step 9: Check Session Status

```bash
node <skill_dir>/scripts/mcp-client.mjs --server $SERVER session-info <session_key>
```

## Important Notes

- **Session TTL**: Sessions expire after 24 hours. Create a new one if expired.
- **Element format**: Always call `read-me` once before the first `create-view` in a conversation to learn the element JSON schema.
- **Camera control**: Include a `cameraUpdate` pseudo-element to set the viewport: `{"type":"cameraUpdate","width":800,"height":600,"x":0,"y":0}`
- **Checkpoints**: Each `create-view` returns a checkpoint ID. Use it with `restore-checkpoint` to build incrementally instead of re-sending all elements.
- **Viewer URL**: Share the viewer URL with the user — they can see and edit the diagram in their browser. Use `get-view` to retrieve their edits.
- **Element IDs**: Always assign stable `id` values to elements so they can be individually deleted or referenced.
- **Progressive ordering**: Emit elements in visual order (background shapes first, then per-node: shape, label, arrows) for best streaming appearance.
- **Max input size**: Element JSON is limited to 5 MB per call.
