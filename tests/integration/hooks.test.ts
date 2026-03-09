/**
 * Integration tests: simulates the OMP agent loading the extension.
 *
 * A MockPi (our simulated OMP agent) is passed to the extension factory.
 * We then fire lifecycle events and assert on the full observable behaviour —
 * which hooks were registered, what messages were sent, and what return values
 * were produced — without spawning any real subprocess or touching the FS.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { makeMockPi, type MockPi } from "../helpers/mock-pi.js";
import { makeMockDB, type MockDB } from "../helpers/mock-db.js";
import { ROUTING_BLOCK, READ_GUIDANCE, GREP_GUIDANCE, BASH_GUIDANCE } from "../../src/routing.js";

// --- Mock MCP server so no subprocess is spawned ---
vi.mock("../../src/mcp-server.js", () => ({
  initMcpServer: vi.fn().mockResolvedValue(undefined),
  shutdownMcpServer: vi.fn().mockResolvedValue(undefined),
}));

// --- Mock DB so no real SQLite files are created ---
vi.mock("../../src/session/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/session/db.js")>();
  return { ...actual, getSessionDB: vi.fn() };
});

import { getSessionDB } from "../../src/session/db.js";
import { initMcpServer } from "../../src/mcp-server.js";
import extensionFactory from "../../src/index.js";

const PROJECT_DIR = "/integration/project";

let pi: MockPi;
let mockDB: MockDB;

beforeAll(async () => {
  pi = makeMockPi();
  mockDB = makeMockDB();
  vi.mocked(getSessionDB).mockReturnValue(mockDB as unknown as ReturnType<typeof getSessionDB>);
  // Load the extension — this calls pi.on() for all lifecycle hooks
  await extensionFactory(pi as unknown as import("../../src/types.js").ExtensionAPI);
});

// ---------------------------------------------------------------------------
// 1. Hook registration — verify OMP agent receives all lifecycle hooks
// ---------------------------------------------------------------------------

describe("hook registration", () => {
  it("registers a session_start handler", () => {
    expect(pi._handlers.has("session_start")).toBe(true);
  });

  it("registers a tool_call handler", () => {
    expect(pi._handlers.has("tool_call")).toBe(true);
  });

  it("registers a tool_result handler", () => {
    expect(pi._handlers.has("tool_result")).toBe(true);
  });

  it("registers a session_before_compact handler", () => {
    expect(pi._handlers.has("session_before_compact")).toBe(true);
  });

  it("registers an input handler", () => {
    expect(pi._handlers.has("input")).toBe(true);
  });

  it("registers a session_shutdown handler", () => {
    expect(pi._handlers.has("session_shutdown")).toBe(true);
  });

  it("registers 2 session_start handlers (routing + MCP boot)", () => {
    // One from registerSessionStartHandler, one from index.ts for MCP boot
    expect((pi._handlers.get("session_start") ?? []).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. session_start — startup: routing block injected, MCP server booted
// ---------------------------------------------------------------------------

describe("session_start: startup type", () => {
  beforeAll(async () => {
    pi.sentMessages.length = 0;
    vi.mocked(mockDB.getSnapshot).mockReturnValue(undefined);
    vi.mocked(initMcpServer).mockClear();
    await pi.fire("session_start", { sessionType: "startup", sessionId: "int-1" }, { cwd: PROJECT_DIR });
  });

  it("sends the ROUTING_BLOCK to the agent", () => {
    expect(pi.sentMessages.some((m) => m.text === ROUTING_BLOCK)).toBe(true);
  });

  it("sends ROUTING_BLOCK with deliverAs:nextTurn", () => {
    const msg = pi.sentMessages.find((m) => m.text === ROUTING_BLOCK);
    expect((msg?.options as { deliverAs?: string })?.deliverAs).toBe("nextTurn");
  });

  it("boots the MCP server with the correct project dir", () => {
    expect(initMcpServer).toHaveBeenCalledWith(expect.anything(), PROJECT_DIR);
  });

  it("creates a session in the DB", () => {
    expect(mockDB.ensureSession).toHaveBeenCalledWith("int-1", PROJECT_DIR);
  });
});

// ---------------------------------------------------------------------------
// 3. session_start — compact type: snapshot directive injected
// ---------------------------------------------------------------------------

describe("session_start: compact type with snapshot", () => {
  beforeAll(async () => {
    pi.sentMessages.length = 0;
    vi.mocked(mockDB.getSnapshot).mockReturnValue({
      sessionId: "int-2",
      snapshotXml: "<session-resume><pending_tasks><item>finish auth</item></pending_tasks></session-resume>",
      createdAt: Date.now(),
    });
    await pi.fire("session_start", { sessionType: "compact", sessionId: "int-2" }, { cwd: PROJECT_DIR });
  });

  it("sends a session directive (not bare ROUTING_BLOCK)", () => {
    const text = pi.sentMessages[0]?.text ?? "";
    expect(text).toContain("<session-directive>");
  });

  it("directive contains the snapshot content", () => {
    const text = pi.sentMessages[0]?.text ?? "";
    expect(text).toContain("finish auth");
  });

  it("directive mentions ctx_search for history retrieval", () => {
    const text = pi.sentMessages[0]?.text ?? "";
    expect(text).toContain("ctx_search");
  });
});

// ---------------------------------------------------------------------------
// 4. tool_call — HTTP commands are blocked
// ---------------------------------------------------------------------------

describe("tool_call: HTTP blocking", () => {
  it("blocks curl commands", async () => {
    const result = await pi.fire(
      "tool_call",
      { toolName: "bash", params: { command: "curl https://api.example.com" }, toolCallId: "1" },
      { cwd: PROJECT_DIR },
    );
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("ctx_execute");
  });

  it("blocks WebFetch", async () => {
    const result = await pi.fire(
      "tool_call",
      { toolName: "WebFetch", params: { url: "https://x.com" }, toolCallId: "2" },
      { cwd: PROJECT_DIR },
    );
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("ctx_fetch_and_index");
  });

  it("does NOT block safe git commands", async () => {
    const result = await pi.fire(
      "tool_call",
      { toolName: "bash", params: { command: "git status" }, toolCallId: "3" },
      { cwd: PROJECT_DIR },
    );
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. tool_call — guidance messages are sent via sendMessage
// ---------------------------------------------------------------------------

describe("tool_call: guidance injection", () => {
  it("sends READ_GUIDANCE when Read is called", async () => {
    pi.sentMessages.length = 0;
    await pi.fire(
      "tool_call",
      { toolName: "Read", params: { file_path: "src/index.ts" }, toolCallId: "4" },
      { cwd: PROJECT_DIR },
    );
    expect(pi.sentMessages.map((m) => m.text)).toContain(READ_GUIDANCE);
  });

  it("sends GREP_GUIDANCE when Grep is called", async () => {
    pi.sentMessages.length = 0;
    await pi.fire(
      "tool_call",
      { toolName: "Grep", params: { pattern: "TODO" }, toolCallId: "5" },
      { cwd: PROJECT_DIR },
    );
    expect(pi.sentMessages.map((m) => m.text)).toContain(GREP_GUIDANCE);
  });

  it("sends BASH_GUIDANCE for non-HTTP bash commands", async () => {
    pi.sentMessages.length = 0;
    await pi.fire(
      "tool_call",
      { toolName: "bash", params: { command: "ls -la" }, toolCallId: "6" },
      { cwd: PROJECT_DIR },
    );
    expect(pi.sentMessages.map((m) => m.text)).toContain(BASH_GUIDANCE);
  });
});

// ---------------------------------------------------------------------------
// 6. tool_call — sub-agent routing block injection
// ---------------------------------------------------------------------------

describe("tool_call: sub-agent routing injection", () => {
  it("injects ROUTING_BLOCK into agent prompts", async () => {
    const result = await pi.fire(
      "tool_call",
      { toolName: "agent", params: { prompt: "Analyse the repo" }, toolCallId: "7" },
      { cwd: PROJECT_DIR },
    ) as { modify: { prompt: string } };
    expect(result.modify.prompt).toContain(ROUTING_BLOCK);
    expect(result.modify.prompt).toContain("Analyse the repo");
  });
});

// ---------------------------------------------------------------------------
// 7. tool_result — semantic events captured in DB
// ---------------------------------------------------------------------------

describe("tool_result: event capture", () => {
  beforeAll(async () => {
    vi.mocked(mockDB.addEvent).mockClear();
  });

  it("captures file_modified when an Edit tool result arrives", async () => {
    await pi.fire(
      "tool_result",
      { toolName: "Edit", toolCallId: "8", params: { file_path: "src/auth.ts" }, result: { content: "ok" } },
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "file_modified", data: "src/auth.ts" }),
    );
  });

  it("captures git_operation from a bash git commit result", async () => {
    await pi.fire(
      "tool_result",
      {
        toolName: "bash",
        toolCallId: "9",
        params: { command: "git commit -m 'feat: auth'" },
        result: { content: "1 file changed" },
      },
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "git_operation" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 8. input — user prompts captured, system messages filtered
// ---------------------------------------------------------------------------

describe("input: user prompt handling", () => {
  beforeAll(() => {
    vi.mocked(mockDB.addEvent).mockClear();
  });

  it("stores a user prompt", async () => {
    await pi.fire("input", { text: "what does the routing module do?" }, { cwd: PROJECT_DIR });
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "user_prompt" }),
    );
  });

  it("filters out task-notification system messages", async () => {
    vi.mocked(mockDB.addEvent).mockClear();
    await pi.fire("input", { text: "<task-notification>do something</task-notification>" }, { cwd: PROJECT_DIR });
    expect(mockDB.addEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9. session_before_compact — snapshot persisted
// ---------------------------------------------------------------------------

describe("session_before_compact: snapshot persistence", () => {
  it("saves a snapshot XML when events exist", async () => {
    vi.mocked(mockDB.getEvents).mockReturnValue([
      { id: 1, sessionId: "int-compact", eventType: "task", data: "pending task", timestamp: 1 },
    ]);
    vi.mocked(mockDB.saveSnapshot).mockClear();
    await pi.fire(
      "session_before_compact",
      { sessionId: "int-compact" },
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.saveSnapshot).toHaveBeenCalledWith(
      "int-compact",
      expect.stringContaining("pending task"),
    );
  });
});

// ---------------------------------------------------------------------------
// 10. session_shutdown — graceful MCP server teardown
// ---------------------------------------------------------------------------

describe("session_shutdown", () => {
  it("calls shutdownMcpServer on shutdown", async () => {
    const { shutdownMcpServer } = await import("../../src/mcp-server.js");
    vi.mocked(shutdownMcpServer).mockClear();
    await pi.fire("session_shutdown", {}, { cwd: PROJECT_DIR });
    expect(shutdownMcpServer).toHaveBeenCalled();
  });
});
