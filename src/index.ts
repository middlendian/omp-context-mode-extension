/**
 * omp-context-mode — oh-my-pi extension entry point.
 *
 * Wires together:
 *   1. context-mode MCP server (spawned as subprocess, tools registered in OMP)
 *   2. Five lifecycle event handlers mirroring context-mode's Claude Code hooks
 *   3. Routing instructions injected at session start
 *
 * Install:
 *   See README.md for one-command installation instructions.
 */

import type { ExtensionAPI, ExtensionFactory } from "./types.js";
import { initMcpServer, shutdownMcpServer } from "./mcp-server.js";
import { registerSessionStartHandler } from "./events/session-start.js";
import { registerToolCallHandler } from "./events/tool-call.js";
import { registerToolResultHandler } from "./events/tool-result.js";
import { registerPreCompactHandler } from "./events/pre-compact.js";
import { registerUserInputHandler } from "./events/user-input.js";

const extension: ExtensionFactory = async (pi: ExtensionAPI) => {
  pi.logger.info("[context-mode] loading omp-context-mode extension");

  // --- Lifecycle event handlers ---
  // Registered synchronously during the load phase (before initialize())

  registerSessionStartHandler(pi);
  registerToolCallHandler(pi);
  registerToolResultHandler(pi);
  registerPreCompactHandler(pi);
  registerUserInputHandler(pi);

  // --- Graceful shutdown ---
  pi.on("session_shutdown", async (_event, _ctx) => {
    await shutdownMcpServer();
  });

  // --- MCP server startup ---
  // OMP calls session_start before the first agent turn, so we initialise the
  // MCP server there to have ctx.cwd available. However we also register a
  // one-shot session_start listener here so we can boot the server early.
  pi.on("session_start", async (_event, ctx) => {
    await initMcpServer(pi, ctx.cwd);
  });

  pi.logger.info("[context-mode] extension loaded — awaiting session_start to boot MCP server");
};

export default extension;
