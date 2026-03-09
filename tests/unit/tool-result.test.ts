import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeMockPi, type MockPi } from "../helpers/mock-pi.js";
import { makeMockDB, type MockDB } from "../helpers/mock-db.js";

vi.mock("../../src/session/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/session/db.js")>();
  return { ...actual, getSessionDB: vi.fn() };
});

import { getSessionDB } from "../../src/session/db.js";
import { registerToolResultHandler } from "../../src/events/tool-result.js";

const PROJECT_DIR = "/test/project";

let pi: MockPi;
let mockDB: MockDB;

beforeEach(() => {
  pi = makeMockPi();
  mockDB = makeMockDB();
  vi.mocked(getSessionDB).mockReturnValue(mockDB as unknown as ReturnType<typeof getSessionDB>);
  registerToolResultHandler(pi);
});

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe("handler registration", () => {
  it("registers exactly one 'tool_result' handler", () => {
    expect(pi._handlers.get("tool_result")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Event capture from tool results
// ---------------------------------------------------------------------------

describe("event capture", () => {
  function makeResultEvent(
    toolName: string,
    params: Record<string, unknown>,
    resultContent: string | null = null,
  ) {
    return {
      toolName,
      toolCallId: "tc-1",
      params,
      result: { content: resultContent },
    };
  }

  it("captures file_modified when Edit succeeds", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("Edit", { file_path: "src/index.ts" }),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "file_modified", data: "src/index.ts" }),
    );
  });

  it("captures file_modified when Write succeeds", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("Write", { path: "output.txt" }, "written"),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "file_modified", data: "output.txt" }),
    );
  });

  it("captures git_operation for git commit in bash", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("bash", { command: "git commit -m 'feat: add tests'" }, "1 file changed"),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "git_operation" }),
    );
  });

  it("captures error event when bash result contains 'error'", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("bash", { command: "tsc" }, "error TS2322: Type mismatch"),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "error" }),
    );
  });

  it("captures task event for TodoWrite", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("TodoWrite", { todos: [{ content: "implement auth", status: "pending" }] }),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "task" }),
    );
  });

  it("adds no events for tools with no semantic meaning (e.g. Glob)", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("Glob", { pattern: "**/*.ts" }, "src/index.ts\nsrc/types.ts"),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).not.toHaveBeenCalled();
  });

  it("handles string result.content directly", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("bash", { command: "git push origin main" }, "Everything up-to-date"),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "git_operation" }),
    );
  });

  it("handles array result.content by JSON-stringifying", async () => {
    await pi.fire(
      "tool_result",
      {
        toolName: "bash",
        toolCallId: "1",
        params: { command: "git push origin main" },
        result: { content: [{ type: "text", text: "pushed" }] },
      },
      { cwd: PROJECT_DIR },
    );
    // Should not throw; git_operation should be captured from the command
    expect(mockDB.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "git_operation" }),
    );
  });

  it("calls ensureSession on every call", async () => {
    await pi.fire(
      "tool_result",
      makeResultEvent("Edit", { file_path: "f.ts" }),
      { cwd: PROJECT_DIR },
    );
    expect(mockDB.ensureSession).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  it("does not throw if getSessionDB throws", async () => {
    vi.mocked(getSessionDB).mockImplementation(() => {
      throw new Error("DB down");
    });
    await expect(
      pi.fire("tool_result", { toolName: "Edit", params: { file_path: "x.ts" }, toolCallId: "1", result: null }),
    ).resolves.not.toThrow();
  });
});
