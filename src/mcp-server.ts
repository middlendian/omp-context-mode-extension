/**
 * MCP server manager.
 *
 * Spawns the context-mode MCP server as a stdio subprocess using the
 * @modelcontextprotocol/sdk client, then registers every ctx_* tool it
 * exposes as a native OMP tool so the model can call them directly.
 *
 * CLAUDE_PROJECT_DIR is set to ctx.cwd so context-mode uses the same
 * session DB paths as our hook handlers.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "./types.js";
import { verifySchemaCompat } from "./session/db.js";

// ---------------------------------------------------------------------------
// Version pin
// ---------------------------------------------------------------------------

/**
 * The exact context-mode version this extension has been validated against.
 *
 * Bump this ONLY after following docs/how-to-update-context-mode.md:
 *   1. Check the npm changelog for schema or tool-name changes.
 *   2. Update REQUIRED_COLUMNS in session/db.ts if any column changed.
 *   3. Run `npm test` — all 200+ tests must pass.
 *   4. Smoke-test a live OMP session (startup, compaction, resume).
 */
export const CONTEXT_MODE_VERSION = "1.0.15";

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

interface McpHandle {
  client: Client;
  tools: McpTool[];
}

let handle: McpHandle | null = null;

/**
 * Start the context-mode MCP server as a subprocess and return an MCP client
 * connected to it via stdio transport.
 */
async function startContextModeServer(projectDir: string): Promise<McpHandle> {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["--yes", `context-mode@${CONTEXT_MODE_VERSION}`],
    env: {
      ...process.env,
      // Tell context-mode which project it's operating on so it uses the
      // correct per-project session DB (matches our hook handler paths)
      CLAUDE_PROJECT_DIR: projectDir,
      // Suppress interactive output — we're using stdio for MCP protocol
      NO_COLOR: "1",
      CI: "1",
    },
  });

  const client = new Client(
    { name: "omp-context-mode", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  const { tools } = await client.listTools();

  return { client, tools };
}

// ---------------------------------------------------------------------------
// Tool schema conversion
// ---------------------------------------------------------------------------

/**
 * Convert an MCP tool's inputSchema to a plain JSON Schema object that OMP's
 * tool registration accepts.
 */
function mcpSchemaToOmpSchema(inputSchema: McpTool["inputSchema"]): Record<string, unknown> {
  // inputSchema is already a JSON Schema object — pass it through
  return inputSchema as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all tools exposed by the context-mode MCP server as native OMP
 * extension tools. Each tool is a thin proxy that calls the MCP server.
 */
async function registerMcpTools(pi: ExtensionAPI, client: Client, tools: McpTool[]): Promise<void> {
  for (const tool of tools) {
    // Capture for closure
    const toolName = tool.name;

    pi.registerTool({
      name: toolName,
      description: tool.description ?? `context-mode: ${toolName}`,
      parameters: mcpSchemaToOmpSchema(tool.inputSchema),

      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal,
        onUpdate: (partial: string) => void,
        _ctx: ExtensionContext,
      ): Promise<AgentToolResult> {
        // Proxy the call to the MCP server
        const result = await client.callTool(
          { name: toolName, arguments: params },
          undefined,
          { signal },
        );

        // Stream any intermediate content
        // MCP SDK types result.content as {} — cast to known shape
        const content = (result.content ?? []) as Array<{ type: string; text: string }>;
        const textParts: string[] = [];

        for (const part of content) {
          if (part.type === "text") {
            textParts.push(part.text);
            onUpdate(part.text);
          }
        }

        return {
          content: textParts.join(""),
          isError: result.isError === true,
        };
      },
    });
  }

  pi.logger.info(
    `[context-mode] registered ${tools.length} MCP tools: ${tools.map((t) => t.name).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the MCP server for the given project directory and register all
 * context-mode tools in OMP. Idempotent — calling multiple times is safe.
 */
export async function initMcpServer(pi: ExtensionAPI, projectDir: string): Promise<void> {
  if (handle) return; // already running

  try {
    handle = await startContextModeServer(projectDir);
    // After the server starts it initialises its SQLite DB. Verify our schema
    // is still compatible so we detect context-mode version drift early.
    verifySchemaCompat(projectDir, pi.logger);
    await registerMcpTools(pi, handle.client, handle.tools);
  } catch (err) {
    pi.logger.error(
      "[context-mode] failed to start MCP server — ctx_* tools will be unavailable:",
      err,
    );
    pi.logger.error(
      "[context-mode] ensure context-mode is available: npm install -g context-mode",
    );
  }
}

/**
 * Gracefully shut down the MCP server subprocess.
 */
export async function shutdownMcpServer(): Promise<void> {
  if (!handle) return;
  try {
    await handle.client.close();
  } catch {
    // ignore errors on shutdown
  }
  handle = null;
}
