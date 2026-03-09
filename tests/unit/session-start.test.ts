import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeMockPi, type MockPi } from "../helpers/mock-pi.js";
import { makeMockDB, type MockDB } from "../helpers/mock-db.js";
import { ROUTING_BLOCK } from "../../src/routing.js";

vi.mock("../../src/session/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/session/db.js")>();
  return { ...actual, getSessionDB: vi.fn() };
});

import { getSessionDB } from "../../src/session/db.js";
import { registerSessionStartHandler } from "../../src/events/session-start.js";

const PROJECT_DIR = "/test/project";

let pi: MockPi;
let mockDB: MockDB;

beforeEach(() => {
  pi = makeMockPi();
  mockDB = makeMockDB();
  vi.mocked(getSessionDB).mockReturnValue(mockDB as unknown as ReturnType<typeof getSessionDB>);
  registerSessionStartHandler(pi);
});

function fire(sessionType: string, sessionId?: string) {
  return pi.fire(
    "session_start",
    { sessionType, sessionId },
    { cwd: PROJECT_DIR },
  );
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe("handler registration", () => {
  it("registers at least one session_start handler", () => {
    expect((pi._handlers.get("session_start") ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// startup session type
// ---------------------------------------------------------------------------

describe("sessionType: startup", () => {
  it("ensures the session exists", async () => {
    await fire("startup", "sess-1");
    expect(mockDB.ensureSession).toHaveBeenCalledWith("sess-1", PROJECT_DIR);
  });

  it("deletes old sessions", async () => {
    await fire("startup", "sess-1");
    expect(mockDB.deleteOldSessions).toHaveBeenCalledWith("sess-1");
  });

  it("resets cleanup flag to 0", async () => {
    await fire("startup", "sess-1");
    expect(mockDB.setCleanupFlag).toHaveBeenCalledWith("sess-1", 0);
  });

  it("sends ROUTING_BLOCK with deliverAs:nextTurn", async () => {
    await fire("startup");
    const msg = pi.sentMessages.find((m) => m.text === ROUTING_BLOCK);
    expect(msg).toBeDefined();
    expect((msg?.options as { deliverAs?: string })?.deliverAs).toBe("nextTurn");
  });

  it("sends exactly one message", async () => {
    await fire("startup");
    expect(pi.sentMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// compact session type
// ---------------------------------------------------------------------------

describe("sessionType: compact — no snapshot available", () => {
  it("sends ROUTING_BLOCK as fallback when no snapshot exists", async () => {
    await fire("compact", "sess-2");
    const msgs = pi.sentMessages.map((m) => m.text);
    expect(msgs).toContain(ROUTING_BLOCK);
  });
});

describe("sessionType: compact — snapshot available", () => {
  beforeEach(() => {
    // Pre-populate a snapshot so getSnapshot() returns something
    vi.mocked(mockDB.getSnapshot).mockReturnValue({
      sessionId: "sess-3",
      snapshotXml: "<session-resume><pending_tasks><item>task A</item></pending_tasks></session-resume>",
      createdAt: Date.now(),
    });
  });

  it("sends a session directive containing the snapshot", async () => {
    await fire("compact", "sess-3");
    const msg = pi.sentMessages[0];
    expect(msg?.text).toContain("task A");
    expect(msg?.text).toContain("<session-directive>");
  });

  it("includes the project dir in the directive", async () => {
    await fire("compact", "sess-3");
    expect(pi.sentMessages[0]?.text).toContain(PROJECT_DIR);
  });

  it("sends with deliverAs:nextTurn", async () => {
    await fire("compact", "sess-3");
    expect((pi.sentMessages[0]?.options as { deliverAs?: string })?.deliverAs).toBe("nextTurn");
  });
});

// ---------------------------------------------------------------------------
// resume session type
// ---------------------------------------------------------------------------

describe("sessionType: resume — no events", () => {
  it("sends ROUTING_BLOCK as fallback when no events exist", async () => {
    await fire("resume", "sess-r");
    expect(pi.sentMessages.map((m) => m.text)).toContain(ROUTING_BLOCK);
  });
});

describe("sessionType: resume — with events", () => {
  beforeEach(() => {
    vi.mocked(mockDB.getEvents).mockReturnValue([
      { id: 1, sessionId: "sess-r", eventType: "task", data: "implement auth", timestamp: 1 },
      { id: 2, sessionId: "sess-r", eventType: "file_modified", data: "src/auth.ts", timestamp: 2 },
      { id: 3, sessionId: "sess-r", eventType: "error", data: "TS2322 type error", timestamp: 3 },
    ]);
  });

  it("sends a summary containing tasks", async () => {
    await fire("resume", "sess-r");
    const msg = pi.sentMessages[0]?.text ?? "";
    expect(msg).toContain("implement auth");
  });

  it("sends a summary containing modified files", async () => {
    await fire("resume", "sess-r");
    const msg = pi.sentMessages[0]?.text ?? "";
    expect(msg).toContain("src/auth.ts");
  });

  it("sends a summary containing recent errors", async () => {
    await fire("resume", "sess-r");
    const msg = pi.sentMessages[0]?.text ?? "";
    expect(msg).toContain("TS2322");
  });

  it("includes ROUTING_BLOCK in the resume message", async () => {
    await fire("resume", "sess-r");
    expect(pi.sentMessages[0]?.text).toContain(ROUTING_BLOCK);
  });
});

// ---------------------------------------------------------------------------
// clear session type
// ---------------------------------------------------------------------------

describe("sessionType: clear", () => {
  it("ensures the session exists", async () => {
    await fire("clear", "sess-c");
    expect(mockDB.ensureSession).toHaveBeenCalledWith("sess-c", PROJECT_DIR);
  });

  it("sets cleanup flag to 1", async () => {
    await fire("clear", "sess-c");
    expect(mockDB.setCleanupFlag).toHaveBeenCalledWith("sess-c", 1);
  });

  it("sends ROUTING_BLOCK", async () => {
    await fire("clear");
    expect(pi.sentMessages.map((m) => m.text)).toContain(ROUTING_BLOCK);
  });
});

// ---------------------------------------------------------------------------
// Session ID derivation
// ---------------------------------------------------------------------------

describe("session ID derivation", () => {
  it("uses the provided session ID", async () => {
    await fire("startup", "explicit-id-123");
    expect(mockDB.ensureSession).toHaveBeenCalledWith("explicit-id-123", PROJECT_DIR);
  });

  it("derives a fallback ID when no session ID is provided", async () => {
    await fire("startup", undefined);
    const call = vi.mocked(mockDB.ensureSession).mock.calls[0];
    // Fallback ID should be a non-empty string
    expect(typeof call[0]).toBe("string");
    expect(call[0].length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  it("does not throw even if getSessionDB throws", async () => {
    vi.mocked(getSessionDB).mockImplementation(() => {
      throw new Error("DB unavailable");
    });
    await expect(fire("startup")).resolves.not.toThrow();
  });

  it("does not throw for an unrecognised session type", async () => {
    await expect(fire("unknown_type", "s")).resolves.not.toThrow();
  });
});
