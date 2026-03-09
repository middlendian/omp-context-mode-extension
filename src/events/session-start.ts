/**
 * session_start handler — equivalent to context-mode's SessionStart hook.
 *
 * Handles four session types:
 *   startup — fresh session: clean old data, capture rule files, init DB
 *   compact — resumed after auto-compaction: inject snapshot + directive
 *   resume  — user-initiated --continue: restore full history context
 *   clear   — user cleared context: fresh start, no snapshot
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, SessionStartEvent, ExtensionContext } from "../types.js";
import { getSessionDB } from "../session/db.js";
import {
  deriveSessionId,
  getCleanupFlagPath,
} from "../session/helpers.js";
import { ROUTING_BLOCK, buildSessionDirective } from "../routing.js";

/** Rule file names OMP might use (analogous to CLAUDE.md in Claude Code) */
const RULE_FILE_NAMES = [
  "AGENT.md",
  "agent.md",
  ".omp/RULES.md",
  ".omp/rules.md",
  "CLAUDE.md", // picked up if the project also targets Claude Code
];

function captureRuleFiles(projectDir: string, sessionId: string, db: ReturnType<typeof getSessionDB>): void {
  const searchDirs = [os.homedir(), projectDir, path.join(projectDir, ".omp")];
  for (const dir of searchDirs) {
    for (const name of RULE_FILE_NAMES) {
      const filePath = path.join(dir, name);
      try {
        const content = fs.readFileSync(filePath, "utf8");
        db.saveRuleFile(sessionId, filePath, content);
      } catch {
        // file doesn't exist — skip
      }
    }
  }
}

export function registerSessionStartHandler(pi: ExtensionAPI): void {
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    try {
    const projectDir = ctx.cwd;
    const sessionId = deriveSessionId(
      (event as { sessionId?: string }).sessionId,
      projectDir,
    );
    const db = getSessionDB(projectDir);
    const cleanupFlagPath = getCleanupFlagPath(projectDir);

    const sessionType = event.sessionType ?? "startup";

    {
      switch (sessionType) {
        case "startup": {
          // Fresh session — purge old data and start clean
          db.ensureSession(sessionId, projectDir);
          db.deleteOldSessions(sessionId);
          db.setCleanupFlag(sessionId, 0);
          captureRuleFiles(projectDir, sessionId, db);

          // Remove any stale cleanup flag
          try { fs.unlinkSync(cleanupFlagPath); } catch { /* ok */ }

          // Inject routing instructions so the model knows about ctx_* tools
          pi.sendMessage(ROUTING_BLOCK, { deliverAs: "nextTurn" });
          break;
        }

        case "compact": {
          // Resumed after auto-compaction — restore snapshot
          db.ensureSession(sessionId, projectDir);
          const snapshot = db.getSnapshot(sessionId);

          if (snapshot) {
            const directive = buildSessionDirective(snapshot.snapshotXml, projectDir);
            pi.sendMessage(directive, { deliverAs: "nextTurn" });
          } else {
            // No snapshot available — inject routing block at minimum
            pi.sendMessage(ROUTING_BLOCK, { deliverAs: "nextTurn" });
          }
          break;
        }

        case "resume": {
          // User-initiated --continue — restore full history context
          db.ensureSession(sessionId, projectDir);
          const events = db.getEvents(sessionId);

          if (events.length > 0) {
            const pendingTasks = events.filter(
              (e) => e.eventType === "task",
            );
            const recentErrors = events.filter(
              (e) => e.eventType === "error",
            ).slice(-3);
            const modifiedFiles = [
              ...new Set(
                events
                  .filter((e) => e.eventType === "file_modified")
                  .map((e) => e.data),
              ),
            ].slice(-10);

            let resumeCtx = ROUTING_BLOCK + "\n\n<session-resume-summary>\n";
            if (pendingTasks.length)
              resumeCtx += `Tasks:\n${pendingTasks.map((t) => `  - ${t.data}`).join("\n")}\n`;
            if (modifiedFiles.length)
              resumeCtx += `Modified files:\n${modifiedFiles.map((f) => `  - ${f}`).join("\n")}\n`;
            if (recentErrors.length)
              resumeCtx += `Recent errors:\n${recentErrors.map((e) => `  - ${e.data.slice(0, 100)}`).join("\n")}\n`;
            resumeCtx += "</session-resume-summary>";

            pi.sendMessage(resumeCtx, { deliverAs: "nextTurn" });
          } else {
            pi.sendMessage(ROUTING_BLOCK, { deliverAs: "nextTurn" });
          }
          break;
        }

        case "clear": {
          // Context cleared — fresh start, no snapshot
          db.ensureSession(sessionId, projectDir);
          db.setCleanupFlag(sessionId, 1);
          try { fs.writeFileSync(cleanupFlagPath, "1"); } catch { /* ok */ }
          pi.sendMessage(ROUTING_BLOCK, { deliverAs: "nextTurn" });
          break;
        }
      }
    } // end switch block
    } catch (err) {
      // session_start must never crash the session
      pi.logger.error("[context-mode] session_start error:", err);
    }
  });
}
