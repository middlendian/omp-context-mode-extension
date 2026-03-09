/**
 * session_before_compact handler — equivalent to context-mode's PreCompact hook.
 *
 * Builds a priority-tiered XML snapshot of the current session state and
 * persists it to SQLite before the context window is compacted. The snapshot
 * is retrieved and injected by the session_start handler when the session
 * resumes (sessionType === "compact").
 */

import type {
  ExtensionAPI,
  SessionCompactEvent,
  ExtensionContext,
} from "../types.js";
import { getSessionDB } from "../session/db.js";
import { deriveSessionId } from "../session/helpers.js";
import { buildSessionSnapshot } from "../routing.js";

export function registerPreCompactHandler(pi: ExtensionAPI): void {
  pi.on("session_before_compact", async (event: SessionCompactEvent, ctx: ExtensionContext) => {
    try {
      const projectDir = ctx.cwd;
      const sessionId = deriveSessionId(
        (event as { sessionId?: string }).sessionId,
        projectDir,
      );
      const db = getSessionDB(projectDir);

      // Ensure the session row exists
      db.ensureSession(sessionId, projectDir);

      // Fetch all captured events for this session
      const events = db.getEvents(sessionId);

      if (events.length === 0) return;

      // Build the compact XML snapshot (<2 KB)
      const snapshotXml = buildSessionSnapshot(events);

      // Persist for retrieval after compaction
      db.saveSnapshot(sessionId, snapshotXml);

      // Increment the compact counter so ctx_stats can report it
      db.incrementCompactCount(sessionId);

      pi.logger.debug(
        `[context-mode] snapshot saved (${snapshotXml.length} bytes, session ${sessionId})`,
      );
    } catch (err) {
      // Never interrupt compaction
      pi.logger.error("[context-mode] pre-compact error:", err);
    }
  });
}
