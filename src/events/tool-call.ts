/**
 * tool_call handler — equivalent to context-mode's PreToolUse hook.
 *
 * Intercepts tool calls before execution to:
 *   1. Block or redirect raw curl/wget/HTTP commands to sandbox
 *   2. Block direct WebFetch in favour of ctx_fetch_and_index
 *   3. Nudge Read and Grep calls with guidance via sendMessage
 *   4. Inject routing blocks into sub-agent prompts
 *
 * OMP block return shape: { block: true, reason: string }
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolCallDecision,
  ExtensionContext,
} from "../types.js";
import { BASH_GUIDANCE, READ_GUIDANCE, GREP_GUIDANCE, ROUTING_BLOCK } from "../routing.js";

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/** Commands that should be redirected to ctx_execute / ctx_batch_execute */
const SANDBOX_REDIRECT_PATTERNS: RegExp[] = [
  /\bcurl\b/,
  /\bwget\b/,
  /\bfetch\s*\(/,        // inline JS fetch()
  /\brequests\.get\b/,   // Python requests
  /\bhttp\.get\b/,
  /\bhttps\.get\b/,
];

/** Commands safe to run directly via Bash (never redirect) */
const BASH_ALLOW_PATTERNS: RegExp[] = [
  /^\s*(git|mkdir|rm|mv|cp|cd|ls|cat|echo|export|source|which|type|env|pwd)\b/,
  /^\s*#/,  // comments
];

function shouldRedirectBash(command: string): boolean {
  // Strip heredocs and quoted strings to avoid false positives
  const stripped = command
    .replace(/<<\s*['"]?\w+['"]?[\s\S]*?^\w+/gm, "")
    .replace(/'[^']*'|"[^"]*"/g, '""');

  if (BASH_ALLOW_PATTERNS.some((p) => p.test(stripped))) return false;
  return SANDBOX_REDIRECT_PATTERNS.some((p) => p.test(stripped));
}

// ---------------------------------------------------------------------------
// Routing decisions
// ---------------------------------------------------------------------------

function handleBash(pi: ExtensionAPI, params: Record<string, unknown>): ToolCallDecision {
  const command = (params.command ?? params.cmd ?? "") as string;

  if (shouldRedirectBash(command)) {
    return {
      block: true,
      reason: [
        "context-mode: Direct HTTP commands are blocked to protect context window.",
        "Use ctx_execute or ctx_batch_execute instead:",
        "",
        "```",
        `ctx_execute({ language: "shell", code: ${JSON.stringify(command)} })`,
        "```",
        "",
        "This keeps command output out of the conversation context.",
      ].join("\n"),
    };
  }

  // Nudge: send non-blocking guidance for potentially large-output commands
  pi.sendMessage(BASH_GUIDANCE, { deliverAs: "followUp" });
}

function handleWebFetch(_pi: ExtensionAPI, _params: Record<string, unknown>): ToolCallDecision {
  return {
    block: true,
    reason: [
      "context-mode: WebFetch is blocked to protect context window.",
      "Use ctx_fetch_and_index instead — it fetches, converts to markdown,",
      "chunks and indexes the content so you can search it without filling",
      "the context window:",
      "",
      "```",
      'ctx_fetch_and_index({ url: "<the URL>" })',
      "```",
    ].join("\n"),
  };
}

function handleRead(pi: ExtensionAPI, _params: Record<string, unknown>): ToolCallDecision {
  // Non-blocking — just nudge the model toward ctx_execute_file
  pi.sendMessage(READ_GUIDANCE, { deliverAs: "followUp" });
}

function handleGrep(pi: ExtensionAPI, _params: Record<string, unknown>): ToolCallDecision {
  // Non-blocking — nudge toward ctx_batch_execute / ctx_search
  pi.sendMessage(GREP_GUIDANCE, { deliverAs: "followUp" });
}

function handleAgentOrTask(params: Record<string, unknown>): ToolCallDecision {
  // Inject routing block into sub-agent prompts so child agents also use sandbox tools.
  // Returns { modify } — verify this return shape is supported by the OMP runtime;
  // if not, the call proceeds unmodified (safe fallback).
  const promptKey = ["prompt", "description", "task", "message"].find(
    (k) => typeof params[k] === "string",
  );
  if (!promptKey) return;

  const existingPrompt = params[promptKey] as string;
  if (existingPrompt.includes("ctx_batch_execute")) return; // already has routing

  return {
    modify: {
      ...params,
      [promptKey]: `${existingPrompt}\n\n${ROUTING_BLOCK}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerToolCallHandler(pi: ExtensionAPI): void {
  pi.on("tool_call", (event: ToolCallEvent, _ctx: ExtensionContext): ToolCallDecision => {
    try {
      const name = event.toolName.toLowerCase();

      if (name === "bash" || name === "shell") return handleBash(pi, event.params);
      if (name === "webfetch" || name === "web_fetch") return handleWebFetch(pi, event.params);
      if (name === "read" || name === "read_file") return handleRead(pi, event.params);
      if (name === "grep" || name === "search") return handleGrep(pi, event.params);
      if (name === "agent" || name === "task" || name === "spawn_agent") {
        return handleAgentOrTask(event.params);
      }
    } catch (err) {
      // Routing errors must not block the tool call
      pi.logger.error("[context-mode] tool_call routing error:", err);
    }
  });
}
