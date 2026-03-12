import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod/v4";
import type { CheckpointStore } from "./checkpoint-store.js";
import {
  MAX_INPUT_BYTES,
  RECALL_CHEAT_SHEET,
  generateCheckpointId,
  resolveElements,
} from "./shared.js";

// Works both from source (src/server.ts) and compiled (dist/server.js)
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "dist")
  : import.meta.dirname;

/**
 * Registers all Excalidraw tools and resources on the given McpServer.
 * Shared between local (main.ts) and Vercel (api/mcp.ts) entry points.
 */
export function registerTools(server: McpServer, distDir: string, store: CheckpointStore): void {
  const resourceUri = "ui://excalidraw/mcp-app.html";

  // ============================================================
  // Tool 1: read_me (call before drawing)
  // ============================================================
  server.registerTool(
    "read_me",
    {
      description: "Returns the Excalidraw element format reference with color palettes, examples, and tips. Call this BEFORE using create_view for the first time.",
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      return { content: [{ type: "text", text: RECALL_CHEAT_SHEET }] };
    },
  );

  // ============================================================
  // Tool 2: create_view (Excalidraw SVG)
  // ============================================================
  registerAppTool(server,
    "create_view",
    {
      title: "Draw Diagram",
      description: `Renders a hand-drawn diagram using Excalidraw elements.
Elements stream in one by one with draw-on animations.
Call read_me first to learn the element format.`,
      inputSchema: z.object({
        elements: z.string().describe(
          "JSON array string of Excalidraw elements. Must be valid JSON — no comments, no trailing commas. Keep compact. Call read_me first for format reference."
        ),
      }),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri } },
    },
    async ({ elements }): Promise<CallToolResult> => {
      if (elements.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Elements input exceeds ${MAX_INPUT_BYTES} byte limit. Reduce the number of elements or use checkpoints to build incrementally.` }],
          isError: true,
        };
      }
      let parsed: any[];
      try {
        parsed = JSON.parse(elements);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid JSON in elements: ${(e as Error).message}. Ensure no comments, no trailing commas, and proper quoting.` }],
          isError: true,
        };
      }

      // Resolve restoreCheckpoint references and save fully resolved state
      const result = await resolveElements(parsed, store);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }
      const { resolvedElements, ratioHint } = result;

      const checkpointId = generateCheckpointId();
      await store.save(checkpointId, { elements: resolvedElements });
      return {
        content: [{ type: "text", text: `Diagram displayed! Checkpoint id: "${checkpointId}".
If user asks to create a new diagram - simply create a new one from scratch.
However, if the user wants to edit something on this diagram "${checkpointId}", take these steps:
1) read widget context (using read_widget_context tool) to check if user made any manual edits first
2) decide whether you want to make new diagram from scratch OR - use this one as starting checkpoint:
  simply start from the first element [{"type":"restoreCheckpoint","id":"${checkpointId}"}, ...your new elements...]
  this will use same diagram state as the user currently sees, including any manual edits they made in fullscreen, allowing you to add elements on top.
  To remove elements, use: {"type":"delete","ids":"<id1>,<id2>"}${ratioHint}` }],
        structuredContent: { checkpointId },
      };
    },
  );

  // ============================================================
  // Tool 3: export_to_excalidraw (server-side proxy for CORS)
  // Called by widget via app.callServerTool(), not by the model.
  // ============================================================
  registerAppTool(server,
    "export_to_excalidraw",
    {
      description: "Upload diagram to excalidraw.com and return shareable URL.",
      inputSchema: { json: z.string().describe("Serialized Excalidraw JSON") },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ json }): Promise<CallToolResult> => {
      if (json.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Export data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        // --- Excalidraw v2 binary format ---
        const remappedJson = json;
        // concatBuffers: [version=1 (4B)] [len₁ (4B)] [data₁] [len₂ (4B)] [data₂] ...
        const concatBuffers = (...bufs: Uint8Array[]): Uint8Array => {
          let total = 4; // version header
          for (const b of bufs) total += 4 + b.length;
          const out = new Uint8Array(total);
          const dv = new DataView(out.buffer);
          dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
          let off = 4;
          for (const b of bufs) {
            dv.setUint32(off, b.length);
            off += 4;
            out.set(b, off);
            off += b.length;
          }
          return out;
        };
        const te = new TextEncoder();

        // 1. Inner payload: concatBuffers(fileMetadata, data)
        const fileMetadata = te.encode(JSON.stringify({}));
        const dataBytes = te.encode(remappedJson);
        const innerPayload = concatBuffers(fileMetadata, dataBytes);

        // 2. Compress inner payload with zlib deflate
        const compressed = deflateSync(Buffer.from(innerPayload));

        // 3. Generate AES-GCM 128-bit key + encrypt
        const cryptoKey = await globalThis.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 128 },
          true,
          ["encrypt"],
        );
        const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await globalThis.crypto.subtle.encrypt(
          { name: "AES-GCM", iv },
          cryptoKey,
          compressed,
        );

        // 4. Encoding metadata (tells excalidraw.com how to decode)
        const encodingMeta = te.encode(JSON.stringify({
          version: 2,
          compression: "pako@1",
          encryption: "AES-GCM",
        }));

        // 5. Outer payload: concatBuffers(encodingMeta, iv, encryptedData)
        const payload = Buffer.from(concatBuffers(encodingMeta, iv, new Uint8Array(encrypted)));

        // 5. Upload to excalidraw backend
        const res = await fetch("https://json.excalidraw.com/api/v2/post/", {
          method: "POST",
          body: payload,
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const { id } = (await res.json()) as { id: string };

        // 6. Export key as base64url string
        const jwk = await globalThis.crypto.subtle.exportKey("jwk", cryptoKey);
        const url = `https://excalidraw.com/#json=${id},${jwk.k}`;

        return { content: [{ type: "text", text: url }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Export failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ============================================================
  // Tool 4: save_checkpoint (private — widget only, for user edits)
  // ============================================================
  registerAppTool(server,
    "save_checkpoint",
    {
      description: "Update checkpoint with user-edited state.",
      inputSchema: { id: z.string(), data: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id, data }): Promise<CallToolResult> => {
      if (data.length > MAX_INPUT_BYTES) {
        return {
          content: [{ type: "text", text: `Checkpoint data exceeds ${MAX_INPUT_BYTES} byte limit.` }],
          isError: true,
        };
      }
      try {
        await store.save(id, JSON.parse(data));
        return { content: [{ type: "text", text: "ok" }] };
      } catch (err) {
        return { content: [{ type: "text", text: `save failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ============================================================
  // Tool 5: read_checkpoint (private — widget only)
  // ============================================================
  registerAppTool(server,
    "read_checkpoint",
    {
      description: "Read checkpoint state for restore.",
      inputSchema: { id: z.string() },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const data = await store.load(id);
        if (!data) return { content: [{ type: "text", text: "" }] };
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `read failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // CSP: allow Excalidraw to load fonts from esm.sh
  const cspMeta = {
    ui: {
      csp: {
        resourceDomains: ["https://esm.sh"],
        connectDomains: ["https://esm.sh"],
      },
    },
  };

  // Register the single shared resource for all UI tools
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(distDir, "mcp-app.html"), "utf-8");
      return {
        contents: [{
          uri: resourceUri,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              ...cspMeta.ui,
              prefersBorder: true,
              permissions: { clipboardWrite: {} },
            },
          },
        }],
      };
    },
  );
}

/**
 * Creates a new MCP server instance with Excalidraw drawing tools.
 * Used by local entry point (main.ts) and Docker deployments.
 */
export function createServer(store: CheckpointStore): McpServer {
  const server = new McpServer({
    name: "Excalidraw",
    version: "1.0.0",
  });
  registerTools(server, DIST_DIR, store);
  return server;
}
