/**
 * In-memory mock of SessionDB for tests that exercise handlers without
 * touching the real filesystem.
 */

import { vi } from "vitest";
import type { SessionDB, SessionMeta, SessionSnapshot, SessionEvent } from "../../src/session/db.js";

export interface MockDB extends SessionDB {
  /** Stored sessions, keyed by session id. */
  sessions: Map<string, SessionMeta>;
  /** Stored events, keyed by session id. */
  events: Map<string, SessionEvent[]>;
  /** Stored snapshots, keyed by session id. */
  snapshots: Map<string, SessionSnapshot>;
}

export function makeMockDB(): MockDB {
  const sessions = new Map<string, SessionMeta>();
  const events = new Map<string, SessionEvent[]>();
  const snapshots = new Map<string, SessionSnapshot>();

  return {
    sessions,
    events,
    snapshots,

    ensureSession: vi.fn((sessionId: string, projectDir: string) => {
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          id: sessionId,
          projectDir,
          createdAt: Date.now(),
          compactCount: 0,
          cleanupFlag: 0,
        });
      }
    }),

    getSession: vi.fn((sessionId: string) => sessions.get(sessionId)),

    getLatestSession: vi.fn(() => {
      if (sessions.size === 0) return undefined;
      return [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
    }),

    incrementCompactCount: vi.fn((sessionId: string) => {
      const s = sessions.get(sessionId);
      if (s) s.compactCount++;
    }),

    setCleanupFlag: vi.fn((sessionId: string, value: number) => {
      const s = sessions.get(sessionId);
      if (s) s.cleanupFlag = value;
    }),

    deleteOldSessions: vi.fn((keepSessionId: string) => {
      for (const id of [...sessions.keys()]) {
        if (id !== keepSessionId) {
          sessions.delete(id);
          events.delete(id);
          snapshots.delete(id);
        }
      }
    }),

    addEvent: vi.fn((event: Omit<SessionEvent, "id">) => {
      const list = events.get(event.sessionId) ?? [];
      list.push({ id: list.length + 1, ...event });
      events.set(event.sessionId, list);
    }),

    getEvents: vi.fn((sessionId: string) => events.get(sessionId) ?? []),

    getLatestEvents: vi.fn((limit = 50) => {
      const all = [...events.values()].flat();
      return all.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).slice(0, limit);
    }),

    saveSnapshot: vi.fn((sessionId: string, snapshotXml: string) => {
      snapshots.set(sessionId, { sessionId, snapshotXml, createdAt: Date.now() });
    }),

    getSnapshot: vi.fn((sessionId: string) => snapshots.get(sessionId)),

    saveRuleFile: vi.fn(),

    close: vi.fn(),
  } as unknown as MockDB;
}
