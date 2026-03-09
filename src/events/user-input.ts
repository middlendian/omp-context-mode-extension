/**
 * input handler — equivalent to context-mode's UserPromptSubmit hook.
 *
 * Captures each user turn to maintain context continuity across sessions.
 * Filters out system messages (task notifications, reminders, etc.).
 * Target: <10 ms. All errors are swallowed silently.
 */

import type {
  ExtensionAPI,
  InputEvent,
  ExtensionContext,
} from "../types.js";
import { getSessionDB, extractPromptEvents } from "../session/db.js";
import { deriveSessionId } from "../session/helpers.js";

/** System message prefixes to ignore (mirrors context-mode's filter) */
const SYSTEM_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<context-mode-rules>",
  "<session-directive>",
  "<session-resume",
];

function isSystemMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return SYSTEM_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function registerUserInputHandler(pi: ExtensionAPI): void {
  pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
    try {
      const prompt = event.text ?? "";
      if (!prompt.trim() || isSystemMessage(prompt)) return;

      const projectDir = ctx.cwd;
      const sessionId = deriveSessionId(undefined, projectDir);
      const db = getSessionDB(projectDir);

      db.ensureSession(sessionId, projectDir);

      const now = Date.now();

      // Store raw user prompt
      db.addEvent({
        sessionId,
        eventType: "user_prompt",
        data: prompt.slice(0, 500),
        timestamp: now,
      });

      // Extract and store any semantic events (decisions, corrections, etc.)
      const semantic = extractPromptEvents(prompt);
      for (const ev of semantic) {
        db.addEvent({
          sessionId,
          eventType: ev.eventType,
          data: ev.data,
          timestamp: now,
        });
      }
    } catch {
      // UserPromptSubmit must never block the session — silent fallback
    }
  });
}
