/**
 * Path and identity helpers for the session database.
 *
 * Uses the same path algorithm as context-mode so that session data is shared
 * between the MCP server (running as a subprocess) and these OMP extension
 * hooks — both read/write the same SQLite file.
 *
 * context-mode default config dir is ~/.claude/context-mode/sessions/ (the
 * Claude Code platform config), so we pass CLAUDE_PROJECT_DIR when spawning
 * the MCP server and use the same dir here.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/** Base directory for all context-mode session data */
export function getContextModeDir(): string {
  return path.join(os.homedir(), ".claude", "context-mode");
}

/** Directory where per-project SQLite DBs live */
export function getSessionsDir(): string {
  return path.join(getContextModeDir(), "sessions");
}

/**
 * Stable 16-char hex identifier for a project directory.
 * Must match context-mode's own hash logic so we use the same DB file.
 */
export function projectHash(projectDir: string): string {
  return crypto.createHash("sha256").update(projectDir).digest("hex").slice(0, 16);
}

/** Absolute path to the SQLite DB for a given project */
export function getSessionDBPath(projectDir: string): string {
  return path.join(getSessionsDir(), `${projectHash(projectDir)}.db`);
}

/** Path to the events markdown file used for FTS5 indexing */
export function getSessionEventsPath(projectDir: string): string {
  return path.join(getSessionsDir(), `${projectHash(projectDir)}-events.md`);
}

/** Flag file that distinguishes a fresh startup from a resume */
export function getCleanupFlagPath(projectDir: string): string {
  return path.join(getContextModeDir(), `cleanup-${projectHash(projectDir)}.flag`);
}

/**
 * Derive a stable session ID from an OMP session ID or fall back to a
 * combination of project hash + timestamp bucket (1-hour granularity so
 * a restart in the same hour continues the same logical session).
 */
export function deriveSessionId(ompSessionId: string | undefined, projectDir: string): string {
  if (ompSessionId) return ompSessionId;
  const bucket = Math.floor(Date.now() / 3_600_000); // 1-hour buckets
  return `${projectHash(projectDir)}-${bucket}`;
}
