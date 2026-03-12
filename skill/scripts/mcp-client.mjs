#!/usr/bin/env node
/**
 * Unified MCP client CLI for the Interactive Drawer remote server.
 *
 * Zero external dependencies — uses Node.js native fetch (v18+).
 * Wraps the MCP Streamable HTTP protocol handshake so callers
 * don't need to manage initialize/notification/tool-call sequences.
 *
 * Usage:
 *   node mcp-client.mjs [--server <url>] <command> [args...]
 *
 * Commands:
 *   create-session                          Create a new 24h drawing session
 *   read-me                                 Fetch element format cheat sheet
 *   create-view <session_key> <json_file>   Draw elements (file path or "-" for stdin)
 *   get-view <session_key>                  Get current SVG + element count
 *   update-elements <session_key> <json_file>  Replace elements via REST API
 *   delete-elements <session_key> <id1,id2>    Remove elements by ID
 *   restore-checkpoint <session_key> <checkpoint_id> [json_file]  Restore + optional new elements
 *   session-info <session_key>              Get session metadata
 *
 * Configuration (--server flag > .excalidraw-mcp.json > ~/.excalidraw-mcp.json):
 *   --server <url>   MCP server URL (e.g. http://localhost:3001)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// ============================================================
// Config resolution
// ============================================================

/**
 * Resolve server URL from args, project config, or home config.
 *
 * @param {string[]} args - CLI arguments (may contain --server <url>).
 * @returns {{ serverUrl: string, remainingArgs: string[] }}
 */
function resolveConfig(args) {
  const remaining = [];
  let serverUrl = null;

  // Parse --server flag
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server" && i + 1 < args.length) {
      serverUrl = args[++i];
    } else {
      remaining.push(args[i]);
    }
  }

  if (serverUrl) {
    return { serverUrl, remainingArgs: remaining };
  }

  // Try project-level config
  const projectConfig = resolve(process.cwd(), ".excalidraw-mcp.json");
  if (existsSync(projectConfig)) {
    try {
      const cfg = JSON.parse(readFileSync(projectConfig, "utf-8"));
      if (cfg.server) {
        return { serverUrl: cfg.server, remainingArgs: remaining };
      }
    } catch { /* ignore malformed config */ }
  }

  // Try home-level config
  const homeConfig = join(homedir(), ".excalidraw-mcp.json");
  if (existsSync(homeConfig)) {
    try {
      const cfg = JSON.parse(readFileSync(homeConfig, "utf-8"));
      if (cfg.server) {
        return { serverUrl: cfg.server, remainingArgs: remaining };
      }
    } catch { /* ignore malformed config */ }
  }

  console.error(
    "Error: No server URL configured.\n" +
    "Provide --server <url>, or create .excalidraw-mcp.json with {\"server\": \"...\"}."
  );
  process.exit(1);
}

// ============================================================
// MCP protocol helper
// ============================================================

/**
 * Perform a full MCP handshake (initialize + notification + tool call).
 *
 * @param {string} serverUrl - Base URL of the MCP server.
 * @param {string} method - MCP method (e.g. "tools/call").
 * @param {object} params - Method parameters.
 * @returns {Promise<object>} The MCP response result.
 */
async function mcpCall(serverUrl, method, params = {}) {
  const mcpEndpoint = serverUrl.replace(/\/$/, "") + "/mcp";
  const commonHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  // Step 1: Initialize
  const initRes = await fetch(mcpEndpoint, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mcp-client-cli", version: "1.0.0" },
      },
      id: 1,
    }),
  });

  const sessionId = initRes.headers.get("mcp-session-id");
  const headers = { ...commonHeaders };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  // Step 2: Notification + tool call (batched)
  const callRes = await fetch(mcpEndpoint, {
    method: "POST",
    headers,
    body: JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method, params, id: 2 },
    ]),
  });

  // Step 3: Parse SSE response
  const text = await callRes.text();
  const results = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        results.push(JSON.parse(line.slice(6)));
      } catch { /* skip malformed lines */ }
    }
  }

  const result = results.find((r) => r.id === 2) ?? results[0];
  if (!result) {
    throw new Error("No response from MCP server. Is it running?");
  }
  return result;
}

/**
 * Call an MCP tool by name.
 *
 * @param {string} serverUrl - MCP server base URL.
 * @param {string} toolName - Tool name (e.g. "create_session").
 * @param {object} toolArgs - Tool arguments.
 * @returns {Promise<object>} Tool call result.
 */
async function callTool(serverUrl, toolName, toolArgs = {}) {
  return mcpCall(serverUrl, "tools/call", { name: toolName, arguments: toolArgs });
}

/**
 * Make a REST API call to the session endpoints.
 *
 * @param {string} serverUrl - MCP server base URL.
 * @param {string} path - API path (e.g. "/api/sessions/<key>").
 * @param {object} options - Fetch options.
 * @returns {Promise<object>} JSON response.
 */
async function restCall(serverUrl, path, options = {}) {
  const url = serverUrl.replace(/\/$/, "") + path;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  return res.json();
}

// ============================================================
// Input helpers
// ============================================================

/**
 * Read JSON content from a file path or stdin ("-").
 *
 * @param {string} source - File path or "-" for stdin.
 * @returns {Promise<string>} Raw JSON string.
 */
async function readJsonInput(source) {
  if (source === "-") {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  return readFileSync(resolve(source), "utf-8");
}

/**
 * Print MCP tool result content to stdout.
 *
 * @param {object} response - MCP response object.
 */
function printResult(response) {
  if (response.error) {
    console.error("MCP Error:", response.error.message || JSON.stringify(response.error));
    process.exit(1);
  }

  const content = response.result?.content ?? [];
  for (const item of content) {
    if (item.type === "text") {
      console.log(item.text);
    } else if (item.type === "image") {
      console.log(`[Image: ${item.mimeType}, ${item.data.length} bytes base64]`);
    }
  }
}

// ============================================================
// Commands
// ============================================================

const commands = {
  /** Create a new drawing session. */
  async "create-session"(serverUrl, _args) {
    const res = await callTool(serverUrl, "create_session");
    printResult(res);
  },

  /** Fetch the element format reference. */
  async "read-me"(serverUrl, _args) {
    const res = await callTool(serverUrl, "read_me");
    printResult(res);
  },

  /**
   * Draw elements in a session.
   * Args: <session_key> <json_file_or_stdin>
   */
  async "create-view"(serverUrl, args) {
    if (args.length < 2) {
      console.error("Usage: create-view <session_key> <json_file | ->"); process.exit(1);
    }
    const [sessionKey, source] = args;
    const elements = await readJsonInput(source);
    // Validate JSON before sending
    try { JSON.parse(elements); } catch (e) {
      console.error("Invalid JSON:", e.message); process.exit(1);
    }
    const res = await callTool(serverUrl, "create_view", { session_key: sessionKey, elements });
    printResult(res);
  },

  /**
   * Get the current view of a session.
   * Args: <session_key>
   */
  async "get-view"(serverUrl, args) {
    if (args.length < 1) {
      console.error("Usage: get-view <session_key>"); process.exit(1);
    }
    const res = await callTool(serverUrl, "get_current_view", { session_key: args[0] });
    printResult(res);
  },

  /**
   * Update elements via REST API (bypasses MCP, direct PUT).
   * Args: <session_key> <json_file_or_stdin>
   */
  async "update-elements"(serverUrl, args) {
    if (args.length < 2) {
      console.error("Usage: update-elements <session_key> <json_file | ->"); process.exit(1);
    }
    const [sessionKey, source] = args;
    const raw = await readJsonInput(source);
    let elements;
    try { elements = JSON.parse(raw); } catch (e) {
      console.error("Invalid JSON:", e.message); process.exit(1);
    }
    const result = await restCall(serverUrl, `/api/sessions/${sessionKey}/elements`, {
      method: "PUT",
      body: JSON.stringify({ elements }),
    });
    if (result.error) {
      console.error("Error:", result.error); process.exit(1);
    }
    console.log("Elements updated successfully.");
  },

  /**
   * Delete elements by ID. Fetches current elements, filters out the given IDs, PUTs back.
   * Args: <session_key> <id1,id2,...>
   */
  async "delete-elements"(serverUrl, args) {
    if (args.length < 2) {
      console.error("Usage: delete-elements <session_key> <id1,id2,...>"); process.exit(1);
    }
    const [sessionKey, idsStr] = args;
    const idsToDelete = new Set(idsStr.split(",").map((s) => s.trim()));

    // Fetch current elements
    const current = await restCall(serverUrl, `/api/sessions/${sessionKey}/elements`);
    if (current.error) {
      console.error("Error:", current.error); process.exit(1);
    }

    const before = current.elements.length;
    const filtered = current.elements.filter((el) => !idsToDelete.has(el.id));
    const removed = before - filtered.length;

    if (removed === 0) {
      console.log("No matching elements found. Nothing deleted.");
      return;
    }

    // PUT back the filtered elements
    const result = await restCall(serverUrl, `/api/sessions/${sessionKey}/elements`, {
      method: "PUT",
      body: JSON.stringify({ elements: filtered }),
    });
    if (result.error) {
      console.error("Error:", result.error); process.exit(1);
    }
    console.log(`Deleted ${removed} element(s). ${filtered.length} remaining.`);
  },

  /**
   * Restore from checkpoint, optionally adding new elements.
   * Args: <session_key> <checkpoint_id> [json_file]
   */
  async "restore-checkpoint"(serverUrl, args) {
    if (args.length < 2) {
      console.error("Usage: restore-checkpoint <session_key> <checkpoint_id> [json_file]"); process.exit(1);
    }
    const [sessionKey, checkpointId] = args;
    const elements = [{ type: "restoreCheckpoint", id: checkpointId }];

    // If additional elements file provided, append them
    if (args[2]) {
      const raw = await readJsonInput(args[2]);
      try {
        const extra = JSON.parse(raw);
        if (Array.isArray(extra)) elements.push(...extra);
      } catch (e) {
        console.error("Invalid JSON in additional elements:", e.message); process.exit(1);
      }
    }

    const res = await callTool(serverUrl, "create_view", {
      session_key: sessionKey,
      elements: JSON.stringify(elements),
    });
    printResult(res);
  },

  /**
   * Get session metadata.
   * Args: <session_key>
   */
  async "session-info"(serverUrl, args) {
    if (args.length < 1) {
      console.error("Usage: session-info <session_key>"); process.exit(1);
    }
    const result = await restCall(serverUrl, `/api/sessions/${args[0]}`);
    if (result.error) {
      console.error("Error:", result.error); process.exit(1);
    }
    console.log(`Session: ${result.sessionKey}`);
    console.log(`Has elements: ${result.hasElements}`);
    console.log(`Expires at: ${result.expiresAt}`);
  },
};

// ============================================================
// Main
// ============================================================

const USAGE = `Usage: mcp-client.mjs [--server <url>] <command> [args...]

Commands:
  create-session                                  Create a new 24h drawing session
  read-me                                         Fetch element format cheat sheet
  create-view <session_key> <json_file | ->       Draw elements from file or stdin
  get-view <session_key>                          Get current SVG + viewer URL
  update-elements <session_key> <json_file | ->   Replace all elements via REST API
  delete-elements <session_key> <id1,id2,...>     Remove elements by ID
  restore-checkpoint <key> <checkpoint_id> [file] Restore from checkpoint
  session-info <session_key>                      Get session metadata

Configuration:
  --server <url>         MCP server URL (e.g. http://localhost:3001)
  .excalidraw-mcp.json   Project-level config file
  ~/.excalidraw-mcp.json  Home-level config file`;

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }

  const { serverUrl, remainingArgs } = resolveConfig(rawArgs);
  const command = remainingArgs[0];
  const commandArgs = remainingArgs.slice(1);

  if (!command || !commands[command]) {
    console.error(`Unknown command: ${command}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  try {
    await commands[command](serverUrl, commandArgs);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
