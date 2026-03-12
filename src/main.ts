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

    // When serving static files, default BASE_URL to self (same origin)
    // so viewer links point to this server instead of a separate frontend.
    if (staticDir && !process.env.BASE_URL) {
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
