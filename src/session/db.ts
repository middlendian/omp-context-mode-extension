/**
 * Session database — a thin SQLite wrapper compatible with context-mode's
 * schema so that events written by OMP hooks are visible to the MCP server
 * (ctx_search, ctx_stats, etc.) and vice versa.
 *
 * Schema mirrors context-mode/src/store.ts.
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

export function getSessionDB(projectDir: string): SessionDB {
  let db = cache.get(projectDir);
  if (!db) {
    db = new SessionDB(projectDir);
    cache.set(projectDir, db);
  }
  return db;
}

// ---------------------------------------------------------------------------
// SessionDB
// ---------------------------------------------------------------------------

export class SessionDB {
  private db: Database.Database;

  constructor(projectDir: string) {
    const dbPath = getSessionDBPath(projectDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

  close(): void {
    this.db.close();
    cache.delete(
      (this.db as unknown as { name: string }).name ?? "",
    );
  }
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
