import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeMockPi, type MockPi } from "../helpers/mock-pi.js";
import { makeMockDB, type MockDB } from "../helpers/mock-db.js";
import type { SessionEvent } from "../../src/session/db.js";

vi.mock("../../src/session/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/session/db.js")>();
  return { ...actual, getSessionDB: vi.fn() };
});

import { getSessionDB } from "../../src/session/db.js";
import { registerPreCompactHandler } from "../../src/events/pre-compact.js";

const PROJECT_DIR = "/test/project";

let pi: MockPi;
let mockDB: MockDB;

beforeEach(() => {
  pi = makeMockPi();
  mockDB = makeMockDB();
  vi.mocked(getSessionDB).mockReturnValue(mockDB as unknown as ReturnType<typeof getSessionDB>);
  registerPreCompactHandler(pi);
});

function fire(sessionId = "sess-compact") {
  return pi.fire("session_before_compact", { sessionId }, { cwd: PROJECT_DIR });
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe("handler registration", () => {
  it("registers exactly one session_before_compact handler", () => {
    expect(pi._handlers.get("session_before_compact")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Snapshot building and persistence
// ---------------------------------------------------------------------------

describe("snapshot persistence", () => {
  it("does nothing when no events exist for the session", async () => {
    vi.mocked(mockDB.getEvents).mockReturnValue([]);
    await fire();
    expect(mockDB.saveSnapshot).not.toHaveBeenCalled();
  });

  it("saves a snapshot when events exist", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "sess-compact", eventType: "file_modified", data: "src/index.ts", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    await fire();
    expect(mockDB.saveSnapshot).toHaveBeenCalledWith(
      "sess-compact",
      expect.stringContaining("<session-resume>"),
    );
  });

  it("snapshot XML contains modified files from events", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "s", eventType: "file_modified", data: "lib/auth.ts", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    await fire();
    const [, xml] = vi.mocked(mockDB.saveSnapshot).mock.calls[0];
    expect(xml).toContain("lib/auth.ts");
  });

  it("snapshot XML contains error events", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "s", eventType: "error", data: "TS2304: cannot find name", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    await fire();
    const [, xml] = vi.mocked(mockDB.saveSnapshot).mock.calls[0];
    expect(xml).toContain("TS2304");
  });

  it("snapshot XML contains pending tasks", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "s", eventType: "task", data: "implement feature X", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    await fire();
    const [, xml] = vi.mocked(mockDB.saveSnapshot).mock.calls[0];
    expect(xml).toContain("implement feature X");
  });

  it("increments the compact counter", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "s", eventType: "task", data: "do something", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    await fire();
    expect(mockDB.incrementCompactCount).toHaveBeenCalledWith("sess-compact");
  });

  it("does NOT increment compact counter when no events", async () => {
    vi.mocked(mockDB.getEvents).mockReturnValue([]);
    await fire();
    expect(mockDB.incrementCompactCount).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Session ID handling
// ---------------------------------------------------------------------------

describe("session ID handling", () => {
  it("uses the provided session ID from the event", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "my-session", eventType: "file_modified", data: "x.ts", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    await pi.fire("session_before_compact", { sessionId: "my-session" }, { cwd: PROJECT_DIR });
    expect(mockDB.getEvents).toHaveBeenCalledWith("my-session");
    expect(mockDB.saveSnapshot).toHaveBeenCalledWith("my-session", expect.any(String));
  });

  it("derives a fallback session ID when none provided", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "derived", eventType: "task", data: "task", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    await pi.fire("session_before_compact", {}, { cwd: PROJECT_DIR });
    // Should still call getEvents (with whatever fallback ID was derived)
    expect(mockDB.getEvents).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  it("does not throw if getSessionDB throws", async () => {
    vi.mocked(getSessionDB).mockImplementation(() => {
      throw new Error("DB unavailable");
    });
    await expect(fire()).resolves.not.toThrow();
  });

  it("does not throw if saveSnapshot throws", async () => {
    const events: SessionEvent[] = [
      { id: 1, sessionId: "s", eventType: "error", data: "err", timestamp: 1 },
    ];
    vi.mocked(mockDB.getEvents).mockReturnValue(events);
    vi.mocked(mockDB.saveSnapshot).mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(fire()).resolves.not.toThrow();
  });
});
