/**
 * Entry point for running the MCP server.
 * Run with: npx @mcp-demos/excalidraw-server
 * Or: node dist/index.js [--stdio]
 *
 * HTTP mode (default): Starts the remote MCP server with session management
 *   + REST API endpoints for the viewer page.
 *   Add --static <dir> to also serve frontend files (single-port deployment).
 * stdio mode (--stdio): Starts the local MCP server for embedded use
 *   (e.g. Python backend subprocess). No session support.
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { FileCheckpointStore } from "./checkpoint-store.js";
import { createRemoteServer } from "./remote-server.js";
import { createServer } from "./server.js";
import { SessionStore } from "./session-store.js";

/**
 * Render a simple landing page for sidecar mode.
 * Shows server status, endpoints, and links to documentation.
 *
 * @param baseUrl - Base URL for links.
 * @returns HTML string.
 */
function renderLandingPage(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Excalidraw Sidecar MCP</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #fafafa; color: #1e1e1e; min-height: 100vh;
         display: flex; align-items: center; justify-content: center; }
  .container { max-width: 640px; padding: 40px; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: #6b7280; font-size: 16px; margin-bottom: 32px; }
  .status { display: flex; align-items: center; gap: 8px; margin-bottom: 24px;
            padding: 12px 16px; background: #ecfdf5; border-radius: 8px; border: 1px solid #d1fae5; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; }
  .status span { color: #15803d; font-size: 14px; font-weight: 500; }
  .section { margin-bottom: 24px; }
  .section h2 { font-size: 16px; color: #374151; margin-bottom: 12px; }
  .endpoint { display: flex; justify-content: space-between; align-items: center;
              padding: 10px 14px; background: #fff; border: 1px solid #e5e7eb;
              border-radius: 6px; margin-bottom: 8px; font-size: 14px; }
  .endpoint .path { font-family: 'SF Mono', Monaco, monospace; color: #4a9eed; font-weight: 500; }
  .endpoint .desc { color: #6b7280; }
  .config { background: #1e1e1e; color: #e5e7eb; padding: 16px; border-radius: 8px;
            font-family: 'SF Mono', Monaco, monospace; font-size: 13px;
            line-height: 1.6; overflow-x: auto; white-space: pre; }
  .config .key { color: #7dd3fc; }
  .config .str { color: #86efac; }
  a { color: #4a9eed; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { margin-top: 32px; color: #9ca3af; font-size: 13px; text-align: center; }
</style>
</head>
<body>
<div class="container">
  <h1>Excalidraw Sidecar MCP</h1>
  <p class="subtitle">Remote MCP server for diagram creation by external LLMs</p>

  <div class="status"><div class="dot"></div><span>Server running</span></div>

  <div class="section">
    <h2>Endpoints</h2>
    <div class="endpoint"><span class="path">POST /mcp</span><span class="desc">MCP Streamable HTTP</span></div>
    <div class="endpoint"><span class="path">GET /api/sessions/:key</span><span class="desc">Session metadata</span></div>
    <div class="endpoint"><span class="path">GET /api/sessions/:key/elements</span><span class="desc">Elements JSON</span></div>
    <div class="endpoint"><span class="path">PUT /api/sessions/:key/elements</span><span class="desc">Update elements</span></div>
    <div class="endpoint"><span class="path">GET /api/sessions/:key/svg</span><span class="desc">Rendered SVG</span></div>
    <div class="endpoint"><span class="path">/view/:key</span><span class="desc">Viewer + editor page</span></div>
  </div>

  <div class="section">
    <h2>Connect from Claude Desktop</h2>
    <div class="config">{
  <span class="key">"mcpServers"</span>: {
    <span class="key">"excalidraw"</span>: {
      <span class="key">"url"</span>: <span class="str">"${baseUrl}/mcp"</span>
    }
  }
}</div>
  </div>

  <div class="section">
    <h2>Connect via CLI</h2>
    <div class="config">node mcp-client.mjs --server ${baseUrl} create-session</div>
  </div>

  <div class="footer">
    <a href="https://github.com/anyin233/excalidraw-sidecar-mcp">GitHub</a>
    &nbsp;&middot;&nbsp; No LLM configuration needed &mdash; this server provides tools, external LLMs connect to it.
  </div>
</div>
</body>
</html>`;
}

/**
 * Starts an MCP server with Streamable HTTP transport in stateless mode,
 * plus REST API routes for session management (viewer page).
 *
 * When `staticDir` is provided, also serves frontend static files and handles
 * SPA fallback for client-side routes (e.g. /view/:key). This enables
 * single-port deployment without nginx.
 *
 * @param createServerFn - Factory function that creates a new McpServer instance per request.
 * @param sessionStore - Session store for the viewer page REST API.
 * @param staticDir - Optional path to frontend build directory for static file serving.
 */
export async function startStreamableHTTPServer(
  createServerFn: () => McpServer,
  sessionStore: SessionStore,
  staticDir?: string,
): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);

  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  // JSON body parser for session REST API routes (5 MB to match MAX_INPUT_BYTES)
  app.use("/api/sessions", express.json({ limit: "5mb" }));

  // ============================================================
  // MCP endpoint (Streamable HTTP transport)
  // ============================================================
  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServerFn();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // ============================================================
  // Session REST API routes (for the frontend viewer page)
  // ============================================================

  /** UUID regex for validating session keys. */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Extract and validate session key from Express params. */
  function getKey(req: Request, res: Response): string | null {
    const k = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
    if (!UUID_RE.test(k)) {
      res.status(400).json({ error: "Invalid session key format" });
      return null;
    }
    return k;
  }

  /**
   * GET /api/sessions/:key — Session metadata (existence, expiry).
   */
  app.get("/api/sessions/:key", (req: Request, res: Response) => {
    const key = getKey(req, res);
    if (!key) return;
    const session = sessionStore.getSession(key);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }
    res.json({
      sessionKey: session.sessionKey,
      expiresAt: session.expiresAt.toISOString(),
      hasElements: session.elements.length > 0,
    });
  });

  /**
   * GET /api/sessions/:key/elements — Current elements JSON.
   */
  app.get("/api/sessions/:key/elements", (req: Request, res: Response) => {
    const key = getKey(req, res);
    if (!key) return;
    const session = sessionStore.getSession(key);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }
    res.json({ elements: session.elements });
  });

  /**
   * PUT /api/sessions/:key/elements — Update elements (user edits from viewer).
   */
  app.put("/api/sessions/:key/elements", (req: Request, res: Response) => {
    const key = getKey(req, res);
    if (!key) return;
    const { elements } = req.body;
    if (!Array.isArray(elements)) {
      res.status(400).json({ error: "Request body must contain an 'elements' array" });
      return;
    }
    const updated = sessionStore.updateElements(key, elements);
    if (!updated) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }
    res.json({ ok: true });
  });

  /**
   * GET /api/sessions/:key/svg — Current SVG image.
   */
  app.get("/api/sessions/:key/svg", async (req: Request, res: Response) => {
    const key = getKey(req, res);
    if (!key) return;
    const session = sessionStore.getSession(key);
    if (!session) {
      res.status(404).json({ error: "Session not found or expired" });
      return;
    }
    if (session.elements.length === 0) {
      res.status(404).json({ error: "Session has no diagram yet" });
      return;
    }

    let svg = session.svgCache;
    if (!svg) {
      // Re-render SVG if cache is invalidated
      try {
        const { renderSvg } = await import("./svg-renderer.js");
        svg = await renderSvg(session.elements);
        sessionStore.updateSvgCache(key, svg);
      } catch (err) {
        console.error("SVG rendering error:", err);
        res.status(500).json({ error: "SVG rendering failed" });
        return;
      }
    }

    res.setHeader("Content-Type", "image/svg+xml");
    res.send(svg);
  });

  // ============================================================
  // Static file serving + SPA fallback (single-port deployment)
  // ============================================================
  if (staticDir) {
    const absDir = resolve(staticDir);
    const indexHtml = resolve(absDir, "index.html");

    // Serve static assets (JS, CSS, images, fonts)
    app.use(express.static(absDir, { index: false }));

    // Landing page at "/" — in sidecar mode the chat app is not available,
    // so show a simple page listing active capabilities instead of the
    // chat layout which asks for LLM API keys.
    app.get("/", (_req: Request, res: Response) => {
      const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderLandingPage(baseUrl));
    });

    // SPA fallback: any GET that didn't match an API route or static file
    // serves index.html so client-side routing (e.g. /view/:key) works.
    app.get("/{*path}", (_req: Request, res: Response) => {
      res.sendFile(indexHtml);
    });

    console.log(`Serving frontend from ${absDir}`);
  }

  // ============================================================
  // Start server
  // ============================================================
  const httpServer = app.listen(port, (err) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.log(`MCP server listening on http://localhost:${port}/mcp`);
    console.log(`Session API available at http://localhost:${port}/api/sessions/`);
    if (staticDir) {
      console.log(`Viewer available at http://localhost:${port}/`);
    }
    if (process.env.BASE_URL) {
      console.log(`Viewer links will use base URL: ${process.env.BASE_URL}`);
    }
  });

  const shutdown = () => {
    console.log("\nShutting down...");
    sessionStore.destroy();
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Starts an MCP server with stdio transport.
 * Used by the Python backend subprocess for the existing chat feature.
 *
 * @param createServerFn - Factory function that creates a new McpServer instance.
 */
export async function startStdioServer(
  createServerFn: () => McpServer,
): Promise<void> {
  await createServerFn().connect(new StdioServerTransport());
}

/**
 * Parse --static <dir> from argv.
 *
 * @returns The static directory path, or undefined if not specified.
 */
function parseStaticDir(): string | undefined {
  const idx = process.argv.indexOf("--static");
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  const dir = process.argv[idx + 1];
  const abs = resolve(dir);
  if (!existsSync(abs)) {
    console.error(`Static directory not found: ${abs}`);
    process.exit(1);
  }
  return abs;
}

/**
 * Parse --base-url <url> from argv.
 * Used when the server is behind a reverse proxy and the public-facing URL
 * differs from what the server can see locally.
 *
 * @returns The base URL string, or undefined if not specified.
 */
function parseBaseUrl(): string | undefined {
  const idx = process.argv.indexOf("--base-url");
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1].replace(/\/+$/, ""); // strip trailing slashes
}

async function main() {
  const checkpointStore = new FileCheckpointStore();

  if (process.argv.includes("--stdio")) {
    // stdio mode: local MCP server for the chat feature (unchanged)
    const factory = () => createServer(checkpointStore);
    await startStdioServer(factory);
  } else {
    // HTTP mode: remote MCP server with session management
    const sessionStore = new SessionStore();
    const staticDir = parseStaticDir();
    const cliBaseUrl = parseBaseUrl();

    // BASE_URL priority: --base-url flag > BASE_URL env var > auto-detect
    if (cliBaseUrl) {
      process.env.BASE_URL = cliBaseUrl;
    } else if (staticDir && !process.env.BASE_URL) {
      // When serving static files, default BASE_URL to self (same origin)
      // so viewer links point to this server instead of a separate frontend.
      const port = parseInt(process.env.PORT ?? "3001", 10);
      process.env.BASE_URL = `http://localhost:${port}`;
    }

    const factory = () => createRemoteServer(sessionStore, checkpointStore);
    await startStreamableHTTPServer(factory, sessionStore, staticDir);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
