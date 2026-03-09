/**
 * Session database — a thin SQLite wrapper compatible with context-mode's
 * schema so that events written by OMP hooks are visible to the MCP server
 * (ctx_search, ctx_stats, etc.) and vice versa.
 *
 * Schema mirrors context-mode/src/store.ts — that file is NOT exported from
 * the context-mode npm package (it is a CLI/MCP server, not a library), so we
 * maintain a compatible copy here.  Call verifySchemaCompat() after the MCP
 * server starts to detect drift between our DDL and context-mode's live DB.
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { getSessionDBPath, getSessionsDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventType =
  | "user_prompt"
  | "task"
  | "decision"
  | "git_operation"
  | "error"
  | "file_modified"
  | "plan_mode"
  | "environment_change";

export interface SessionEvent {
  id?: number;
  sessionId: string;
  eventType: EventType;
  data: string;
  timestamp: number;
}

export interface SessionMeta {
  id: string;
  projectDir: string;
  createdAt: number;
  compactCount: number;
  cleanupFlag: number;
}

export interface SessionSnapshot {
  sessionId: string;
  snapshotXml: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// DB singleton per project dir
// ---------------------------------------------------------------------------

const cache = new Map<string, SessionDB>();

export function getSessionDB(projectDir: string, dbPathOverride?: string): SessionDB {
  const key = dbPathOverride ?? projectDir;
  let db = cache.get(key);
  if (!db) {
    db = new SessionDB(projectDir, dbPathOverride);
    cache.set(key, db);
  }
  return db;
}

/** Clear the module-level DB cache. Intended for use in tests only. */
export function clearSessionDBCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// SessionDB
// ---------------------------------------------------------------------------

export class SessionDB {
  private db: Database.Database;

  /**
   * @param projectDir  Project root — used to derive the DB file path.
   * @param dbPathOverride  Override the DB path (e.g. ":memory:" for tests).
   */
  constructor(projectDir: string, dbPathOverride?: string) {
    const dbPath = dbPathOverride ?? getSessionDBPath(projectDir);
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        projectDir TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        compactCount INTEGER NOT NULL DEFAULT 0,
        cleanupFlag INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events (sessionId);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events (eventType);

      CREATE TABLE IF NOT EXISTS snapshots (
        sessionId TEXT PRIMARY KEY,
        snapshotXml TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (sessionId) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS rule_files (
        sessionId TEXT NOT NULL,
        filePath TEXT NOT NULL,
        content TEXT NOT NULL,
        capturedAt INTEGER NOT NULL,
        PRIMARY KEY (sessionId, filePath),
        FOREIGN KEY (sessionId) REFERENCES sessions(id)
      );
    `);
  }

  // --- Session management ---

  ensureSession(sessionId: string, projectDir: string): void {
    const existing = this.db
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(sessionId);
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO sessions (id, projectDir, createdAt, compactCount, cleanupFlag) VALUES (?, ?, ?, 0, 0)",
        )
        .run(sessionId, projectDir, Date.now());
    }
  }

  getSession(sessionId: string): SessionMeta | undefined {
    return this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SessionMeta | undefined;
  }

  getLatestSession(): SessionMeta | undefined {
    return this.db
      .prepare("SELECT * FROM sessions ORDER BY createdAt DESC LIMIT 1")
      .get() as SessionMeta | undefined;
  }

  incrementCompactCount(sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET compactCount = compactCount + 1 WHERE id = ?")
      .run(sessionId);
  }

  setCleanupFlag(sessionId: string, value: number): void {
    this.db
      .prepare("UPDATE sessions SET cleanupFlag = ? WHERE id = ?")
      .run(value, sessionId);
  }

  deleteOldSessions(keepSessionId: string): void {
    this.db
      .prepare("DELETE FROM events WHERE sessionId != ?")
      .run(keepSessionId);
    this.db
      .prepare("DELETE FROM snapshots WHERE sessionId != ?")
      .run(keepSessionId);
    this.db
      .prepare("DELETE FROM rule_files WHERE sessionId != ?")
      .run(keepSessionId);
    this.db
      .prepare("DELETE FROM sessions WHERE id != ?")
      .run(keepSessionId);
  }

  // --- Events ---

  addEvent(event: Omit<SessionEvent, "id">): void {
    this.db
      .prepare(
        "INSERT INTO events (sessionId, eventType, data, timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(event.sessionId, event.eventType, event.data, event.timestamp);
  }

  getEvents(sessionId: string): SessionEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE sessionId = ? ORDER BY timestamp ASC")
      .all(sessionId) as SessionEvent[];
  }

  getLatestEvents(limit = 50): SessionEvent[] {
    const session = this.getLatestSession();
    if (!session) return [];
    return this.db
      .prepare(
        "SELECT * FROM events WHERE sessionId = ? ORDER BY timestamp DESC LIMIT ?",
      )
      .all(session.id, limit) as SessionEvent[];
  }

  // --- Snapshots ---

  saveSnapshot(sessionId: string, snapshotXml: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO snapshots (sessionId, snapshotXml, createdAt) VALUES (?, ?, ?)",
      )
      .run(sessionId, snapshotXml, Date.now());
  }

  getSnapshot(sessionId: string): SessionSnapshot | undefined {
    return this.db
      .prepare("SELECT * FROM snapshots WHERE sessionId = ?")
      .get(sessionId) as SessionSnapshot | undefined;
  }

  // --- Rule files (CLAUDE.md / OMP equivalent) ---

  saveRuleFile(sessionId: string, filePath: string, content: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO rule_files (sessionId, filePath, content, capturedAt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionId, filePath, content, Date.now());
  }

  /**
   * Return the column names for a table in this database.
   * Used by verifySchemaCompat() and schema snapshot tests.
   */
  getTableColumns(tableName: string): string[] {
    const rows = this.db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  close(): void {
    this.db.close();
    cache.delete(
      (this.db as unknown as { name: string }).name ?? "",
    );
  }
}

// ---------------------------------------------------------------------------
// Schema compatibility guard
// ---------------------------------------------------------------------------

/**
 * The minimum columns our extension reads/writes in each table.
 * context-mode may add extra columns at any time — that is fine.
 * If any of THESE columns disappear or are renamed we log a warning.
 */
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  sessions:   ["id", "projectDir", "createdAt", "compactCount", "cleanupFlag"],
  events:     ["id", "sessionId", "eventType", "data", "timestamp"],
  snapshots:  ["sessionId", "snapshotXml", "createdAt"],
  rule_files: ["sessionId", "filePath", "content", "capturedAt"],
};

/**
 * Open the on-disk DB that context-mode created and verify every column in
 * REQUIRED_COLUMNS still exists.  Returns true if compatible, false if any
 * required column is absent (in which case warnings are already logged).
 *
 * Safe to call with a path that doesn't exist yet — returns true (no DB means
 * context-mode hasn't initialised yet, not a mismatch).
 */
export function verifySchemaCompat(
  projectDir: string,
  logger: { warn: (msg: string, ...args: unknown[]) => void },
): boolean {
  const dbPath = getSessionDBPath(projectDir);
  if (!fs.existsSync(dbPath)) return true;

  let db: Database.Database | undefined;
  let ok = true;

  try {
    db = new Database(dbPath, { readonly: true });

    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
      const existing = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((r) => r.name),
      );

      if (existing.size === 0) {
        logger.warn(
          `[context-mode] schema drift: table "${table}" is missing from context-mode DB — ` +
          "session continuity may be degraded. Check context-mode version.",
        );
        ok = false;
        continue;
      }

      for (const col of required) {
        if (!existing.has(col)) {
          logger.warn(
            `[context-mode] schema drift: column "${table}.${col}" is missing from ` +
            "context-mode DB — session continuity may be degraded. Check context-mode version.",
          );
          ok = false;
        }
      }
    }
  } catch (err) {
    // If we can't open the DB at all, log but don't block startup
    logger.warn("[context-mode] schema compatibility check failed:", err);
    ok = false;
  } finally {
    db?.close();
  }

  return ok;
}

// ---------------------------------------------------------------------------
// Event extraction helpers
// ---------------------------------------------------------------------------

interface ExtractedEvent {
  eventType: EventType;
  data: string;
}

/**
 * Infer semantic events from a tool call and its result.
 * Mirrors context-mode's extractUserEvents() logic.
 */
export function extractToolEvents(
  toolName: string,
  params: Record<string, unknown>,
  result?: string,
): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];
  const tool = toolName.toLowerCase();

  if (tool === "edit" || tool === "write" || tool === "multiedit") {
    const filePath = (params.file_path ?? params.path ?? params.filePath) as string | undefined;
    if (filePath) {
      events.push({ eventType: "file_modified", data: filePath });
    }
  }

  if (tool === "bash" || tool === "shell") {
    const cmd = (params.command ?? params.cmd ?? "") as string;
    if (/\bgit\s+commit\b/.test(cmd)) {
      events.push({ eventType: "git_operation", data: cmd.slice(0, 200) });
    } else if (/\bgit\s+(push|pull|merge|rebase|cherry-pick)\b/.test(cmd)) {
      events.push({ eventType: "git_operation", data: cmd.slice(0, 200) });
    }
    if (result && /error|failed|exception/i.test(result) && !/^(true|false|ok)$/i.test(result.trim())) {
      events.push({ eventType: "error", data: result.slice(0, 500) });
    }
  }

  if (tool === "todowrite" || tool === "todo_write") {
    events.push({ eventType: "task", data: JSON.stringify(params).slice(0, 500) });
  }

  return events;
}

/**
 * Extract semantic events from a user prompt.
 */
export function extractPromptEvents(prompt: string): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];

  // Decisions / corrections
  if (/\b(don'?t|never|always|instead|actually|no[,\s]|wrong|mistake|correct)\b/i.test(prompt)) {
    events.push({ eventType: "decision", data: prompt.slice(0, 300) });
  }

  return events;
}
