# Excalidraw Sidecar MCP

MCP server that exposes Excalidraw diagram creation over HTTP for external LLMs. Forked from excalidraw/excalidraw-mcp with added remote session management, server-side SVG rendering, and browser viewer.

## Architecture

```
src/
  main.ts            → Entry point: HTTP (Streamable) + stdio transports + REST API routes
  server.ts          → Local MCP server (stdio): read_me, create_view + widget tools
  remote-server.ts   → Remote MCP server (HTTP): create_session, read_me, create_view, get_current_view
  session-store.ts   → In-memory session store (Map, 24h TTL, 100 max)
  svg-renderer.ts    → Server-side SVG: JSDOM + exportToSvg + fallback renderer
  shared.ts          → Shared constants: RECALL_CHEAT_SHEET, resolveElements(), PSEUDO_TYPES
  checkpoint-store.ts→ Checkpoint persistence (File, Memory, Redis implementations)
  mcp-app.tsx        → ExcalidrawAppCore widget (for MCP Apps / stdio mode)
  mcp-entry.tsx      → Production widget entry point
  global.css         → Animations (stroke draw-on, fade-in)
  dev.tsx            → Dev entry point with mock app
skill/
  SKILL.md           → Claude Code skill definition (/draw command)
  scripts/mcp-client.mjs → Zero-dep CLI wrapping MCP protocol + REST API
  config.example.json    → Config template
docs/
  remote-mcp-api.md  → Full API reference
```

## Two Server Modes

**HTTP mode** (default, `npm run serve`):
- Remote MCP at `/mcp` via Streamable HTTP transport
- REST API at `/api/sessions/*` for viewer page
- Session-based: `create_session` → `create_view` → `get_current_view`
- Server-side SVG rendering via JSDOM + Excalidraw

**stdio mode** (`--stdio` flag):
- Local MCP for Claude Desktop embedded use
- Same `read_me` + `create_view` tools but with MCP App widget (HTML)
- Used by the Python backend subprocess for the chat feature

## Remote MCP Tools

| Tool | Purpose |
|------|---------|
| `create_session` | New 24h session → session key + viewer URL |
| `read_me` | Element format cheat sheet (~400 lines) |
| `create_view` | Render diagram → SVG image + checkpoint ID |
| `get_current_view` | Latest SVG including browser edits |

## REST API Routes (main.ts)

```
GET  /api/sessions/:key           → session metadata
GET  /api/sessions/:key/elements  → current elements JSON
PUT  /api/sessions/:key/elements  → replace elements (viewer edits)
GET  /api/sessions/:key/svg       → rendered SVG image
```

UUID validation on all session key params. 5 MB body limit on PUT.

## SVG Rendering (svg-renderer.ts)

1. JSDOM environment setup (patches globalThis with window, document, navigator, etc.)
2. Dynamic import of @excalidraw/excalidraw after globals are set
3. `convertToExcalidrawElements` + `exportToSvg` for full-fidelity rendering
4. Falls back to `generateFallbackSvg` if Excalidraw import fails (renders basic shapes as SVG elements)
5. `cameraUpdate` pseudo-elements set the SVG viewBox

## Element Resolution (shared.ts)

`resolveElements(parsed, checkpointStore)` handles:
- `restoreCheckpoint` → loads saved state from checkpoint store
- `delete` → removes elements by ID (including bound text via `containerId`)
- Camera aspect ratio check → warns if not ~4:3
- Returns `{ ok, resolvedElements, ratioHint }` or `{ ok: false, error }`

## Session Store (session-store.ts)

- In-memory Map with 24h TTL per session
- Max 100 sessions, evicts oldest when full
- `updateElements()` invalidates SVG cache
- Cleanup timer runs every 10 minutes
- `destroy()` on graceful shutdown

## Build

```bash
npm install
npm run build    # tsc + vite build + tsc server + bun build
npm run serve    # bun --watch src/main.ts
npm run dev      # watch + serve concurrently
```

## Key Design Decisions

- **Standard Excalidraw JSON** — no skeleton API extensions. Any `.excalidraw` file's elements array works as input.
- **SVG-only rendering** — uses `exportToSvg`, not the Excalidraw React canvas. morphdom diffs SVG DOM for smooth updates.
- **Stateless MCP transport** — each HTTP request creates a fresh server instance. No MCP session state on server.
- **Session state is separate from MCP state** — sessions are in SessionStore, MCP transport is stateless per-request.
- **Checkpoint system** — server resolves `restoreCheckpoint` references so the model never re-sends full element arrays.
