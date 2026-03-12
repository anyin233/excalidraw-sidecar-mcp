/**
 * Remote MCP server factory for external LLM access (Claude Desktop, etc.).
 *
 * Exposes 4 tools over Streamable HTTP transport:
 * - create_session: Start a new drawing session (24h TTL)
 * - read_me: Element format reference (same cheat sheet as local server)
 * - create_view: Draw a diagram and get SVG + viewer link
 * - get_current_view: Get the latest view (including user edits)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v4";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { SessionStore } from "./session-store.js";
import {
  MAX_INPUT_BYTES,
  RECALL_CHEAT_SHEET,
  generateCheckpointId,
  resolveElements,
} from "./shared.js";
import { renderSvg } from "./svg-renderer.js";

/** Base URL for viewer links. Defaults to local Vite dev server. */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:5173";

/**
 * Create a remote MCP server instance with session-based drawing tools.
 *
 * @param sessionStore - Session store for managing drawing sessions.
 * @param checkpointStore - Checkpoint store for element state persistence.
 * @returns A configured McpServer instance.
 */
export function createRemoteServer(
  sessionStore: SessionStore,
  checkpointStore: CheckpointStore,
): McpServer {
  const server = new McpServer({
    name: "Interactive Drawer Remote",
    version: "1.0.0",
  });

  // ============================================================
  // Tool 1: create_session
  // ============================================================
  server.registerTool(
    "create_session",
    {
      description:
        "Create a new drawing session. Returns a session key and viewer URL. Sessions expire after 24 hours.",
      annotations: { readOnlyHint: false },
    },
    async (): Promise<CallToolResult> => {
      const session = sessionStore.createSession();
      const viewerUrl = `${BASE_URL}/view/${session.sessionKey}`;
      return {
        content: [
          {
            type: "text",
            text: `Session created!
Session key: "${session.sessionKey}"
Viewer URL: ${viewerUrl}
Expires at: ${session.expiresAt.toISOString()}

Use this session key with create_view to draw diagrams. Share the viewer URL so users can see and edit the diagram in their browser.`,
          },
        ],
      };
    },
  );

  // ============================================================
  // Tool 2: read_me
  // ============================================================
  server.registerTool(
    "read_me",
    {
      description:
        "Returns the Excalidraw element format reference with color palettes, examples, and tips. Call this BEFORE using create_view for the first time.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      return { content: [{ type: "text", text: RECALL_CHEAT_SHEET }] };
    },
  );

  // ============================================================
  // Tool 3: create_view
  // ============================================================
  server.registerTool(
    "create_view",
    {
      description: `Renders a diagram using Excalidraw elements and returns an SVG image + viewer link.
Call read_me first to learn the element format. Requires a session_key from create_session.`,
      inputSchema: {
        session_key: z
          .string()
          .describe("Session key from create_session."),
        elements: z
          .string()
          .describe(
            "JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. Call read_me first for format reference.",
          ),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ session_key, elements }): Promise<CallToolResult> => {
      // Validate session
      const session = sessionStore.getSession(session_key);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "Session not found or expired. Create a new session with create_session.",
            },
          ],
          isError: true,
        };
      }

      // Validate input size
      if (elements.length > MAX_INPUT_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `Elements input exceeds ${MAX_INPUT_BYTES} byte limit. Reduce the number of elements or use checkpoints to build incrementally.`,
            },
          ],
          isError: true,
        };
      }

      // Parse JSON
      let parsed: any[];
      try {
        parsed = JSON.parse(elements);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.`,
            },
          ],
          isError: true,
        };
      }

      // Resolve checkpoint references and deletes
      const result = await resolveElements(parsed, checkpointStore);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }

      const { resolvedElements, ratioHint } = result;

      // Store resolved elements in session
      sessionStore.updateElements(session_key, resolvedElements);

      // Save checkpoint for future restoreCheckpoint references
      const checkpointId = generateCheckpointId();
      await checkpointStore.save(checkpointId, { elements: resolvedElements });

      // Render SVG
      let svgString: string;
      try {
        svgString = await renderSvg(resolvedElements);
      } catch (err) {
        svgString = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><text x="200" y="150" text-anchor="middle" fill="#999">SVG rendering failed</text></svg>';
        console.error("SVG rendering error:", err);
      }

      // Cache SVG
      sessionStore.updateSvgCache(session_key, svgString);

      const viewerUrl = `${BASE_URL}/view/${session_key}`;
      const svgBase64 = Buffer.from(svgString).toString("base64");

      return {
        content: [
          {
            type: "text",
            text: `Diagram rendered! Checkpoint id: "${checkpointId}".
Viewer URL: ${viewerUrl}

To edit this diagram, use restoreCheckpoint:
  [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...your new elements...]

To remove elements: {"type":"delete","ids":"<id1>,<id2>"}${ratioHint}`,
          },
          {
            type: "image",
            data: svgBase64,
            mimeType: "image/svg+xml",
          },
        ],
      };
    },
  );

  // ============================================================
  // Tool 4: get_current_view
  // ============================================================
  server.registerTool(
    "get_current_view",
    {
      description:
        "Get the current diagram view for a session. Returns the latest SVG (including any user edits made via the viewer page).",
      inputSchema: {
        session_key: z
          .string()
          .describe("Session key from create_session."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_key }): Promise<CallToolResult> => {
      const session = sessionStore.getSession(session_key);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "Session not found or expired. Create a new session with create_session.",
            },
          ],
          isError: true,
        };
      }

      if (session.elements.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Session has no diagram yet. Use create_view to draw one first.",
            },
          ],
          isError: true,
        };
      }

      // Re-render SVG if cache is invalidated
      let svgString = session.svgCache;
      if (!svgString) {
        try {
          svgString = await renderSvg(session.elements);
          sessionStore.updateSvgCache(session_key, svgString);
        } catch (err) {
          svgString = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><text x="200" y="150" text-anchor="middle" fill="#999">SVG rendering failed</text></svg>';
          console.error("SVG rendering error:", err);
        }
      }

      const viewerUrl = `${BASE_URL}/view/${session_key}`;
      const svgBase64 = Buffer.from(svgString).toString("base64");

      return {
        content: [
          {
            type: "text",
            text: `Current diagram view.\nViewer URL: ${viewerUrl}`,
          },
          {
            type: "image",
            data: svgBase64,
            mimeType: "image/svg+xml",
          },
        ],
      };
    },
  );

  return server;
}
