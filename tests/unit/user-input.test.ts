import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeMockPi, type MockPi } from "../helpers/mock-pi.js";
import { makeMockDB, type MockDB } from "../helpers/mock-db.js";

// Mock getSessionDB so we don't touch the real filesystem
vi.mock("../../src/session/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/session/db.js")>();
  return { ...actual, getSessionDB: vi.fn() };
});

import { getSessionDB } from "../../src/session/db.js";
import { registerUserInputHandler } from "../../src/events/user-input.js";

const PROJECT_DIR = "/test/project";

let pi: MockPi;
let mockDB: MockDB;

beforeEach(async () => {
  pi = makeMockPi();
  mockDB = makeMockDB();
  vi.mocked(getSessionDB).mockReturnValue(mockDB as unknown as ReturnType<typeof getSessionDB>);
  registerUserInputHandler(pi);
});

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe("handler registration", () => {
  it("registers exactly one 'input' handler", () => {
    expect(pi._handlers.get("input")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// System message filtering
// ---------------------------------------------------------------------------

describe("system message filtering", () => {
  const systemMessages = [
    "<task-notification>some task</task-notification>",
    "<system-reminder>remember this</system-reminder>",
    "<context-mode-rules>...</context-mode-rules>",
    "<session-directive>resume here</session-directive>",
    "<session-resume>snapshot</session-resume>",
    "  <task-notification>with leading spaces</task-notification>",
  ];

  for (const msg of systemMessages) {
    it(`ignores system message: "${msg.slice(0, 50)}"`, async () => {
      await pi.fire("input", { text: msg }, { cwd: PROJECT_DIR });
      expect(mockDB.addEvent).not.toHaveBeenCalled();
    });
  }

  it("ignores empty string", async () => {
    await pi.fire("input", { text: "" }, { cwd: PROJECT_DIR });
    expect(mockDB.addEvent).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only string", async () => {
    await pi.fire("input", { text: "   \n  " }, { cwd: PROJECT_DIR });
    expect(mockDB.addEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// User prompt capture
// ---------------------------------------------------------------------------

describe("user prompt capture", () => {
  it("stores user prompt as user_prompt event", async () => {
    await pi.fire("input", { text: "what does this function do?" }, { cwd: PROJECT_DIR });
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "user_prompt", data: "what does this function do?" }),
    );
  });

  it("truncates prompts longer than 500 chars", async () => {
    const longPrompt = "a".repeat(600);
    await pi.fire("input", { text: longPrompt }, { cwd: PROJECT_DIR });
    const call = vi.mocked(mockDB.addEvent).mock.calls.find(
      ([ev]) => ev.eventType === "user_prompt",
    );
    expect(call![0].data.length).toBe(500);
  });

  it("calls ensureSession to guarantee the session row exists", async () => {
    await pi.fire("input", { text: "hello" }, { cwd: PROJECT_DIR });
    expect(mockDB.ensureSession).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Semantic event extraction
// ---------------------------------------------------------------------------

describe("semantic event extraction", () => {
  it("stores a decision event for correction prompts", async () => {
    await pi.fire(
      "input",
      { text: "actually, don't use that approach" },
      { cwd: PROJECT_DIR },
    );
    const calls = vi.mocked(mockDB.addEvent).mock.calls;
    const eventTypes = calls.map(([ev]) => ev.eventType);
    expect(eventTypes).toContain("decision");
  });

  it("stores both user_prompt AND decision for a correction prompt", async () => {
    await pi.fire("input", { text: "no, that's wrong" }, { cwd: PROJECT_DIR });
    const types = vi.mocked(mockDB.addEvent).mock.calls.map(([ev]) => ev.eventType);
    expect(types).toContain("user_prompt");
    expect(types).toContain("decision");
  });

  it("only stores user_prompt for a neutral question", async () => {
    await pi.fire("input", { text: "how do I use vitest?" }, { cwd: PROJECT_DIR });
    const types = vi.mocked(mockDB.addEvent).mock.calls.map(([ev]) => ev.eventType);
    expect(types).toContain("user_prompt");
    expect(types).not.toContain("decision");
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
    // Must not propagate
    await expect(
      pi.fire("input", { text: "hello" }, { cwd: PROJECT_DIR }),
    ).resolves.not.toThrow();
  });
});
