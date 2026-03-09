/**
 * tool_result handler — equivalent to context-mode's PostToolUse hook.
 *
 * Captures semantic events from tool execution and persists them to SQLite
 * for session continuity (visible to ctx_search, ctx_stats, etc.).
 *
 * Must never block or delay the session. All errors are swallowed silently.
 * Target: <20 ms.
 */

import type {
  ExtensionAPI,
  ToolResultEvent,
  ExtensionContext,
} from "../types.js";
import { getSessionDB, extractToolEvents } from "../session/db.js";
import { deriveSessionId } from "../session/helpers.js";

export function registerToolResultHandler(pi: ExtensionAPI): void {
  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    try {
      const projectDir = ctx.cwd;
      const sessionId = deriveSessionId(undefined, projectDir);
      const db = getSessionDB(projectDir);

      // Ensure session row exists (in case session_start hasn't fired yet)
      db.ensureSession(sessionId, projectDir);

      // Extract result text for pattern matching
      const resultText =
        typeof event.result?.content === "string"
          ? event.result.content
          : JSON.stringify(event.result?.content ?? "");

      const events = extractToolEvents(event.toolName, event.params, resultText);

      const now = Date.now();
      for (const ev of events) {
        db.addEvent({
          sessionId,
          eventType: ev.eventType,
          data: ev.data,
          timestamp: now,
        });
      }
    } catch {
      // PostToolUse must never block the session — silent fallback
    }
  });
}
