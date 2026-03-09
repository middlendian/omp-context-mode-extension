/**
 * Unit tests for the tool_call handler.
 *
 * These test routing decisions from the outside-in: register the handler via
 * the public API, then fire tool_call events and assert on the return value
 * and sendMessage calls — exactly as OMP would do at runtime.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeMockPi, makeCtx, type MockPi } from "../helpers/mock-pi.js";
import { registerToolCallHandler } from "../../src/events/tool-call.js";
import { BASH_GUIDANCE, READ_GUIDANCE, GREP_GUIDANCE, ROUTING_BLOCK } from "../../src/routing.js";

function makeEvent(toolName: string, params: Record<string, unknown>) {
  return { toolName, params, toolCallId: "tc-1" };
}

let pi: MockPi;

beforeEach(() => {
  pi = makeMockPi();
  registerToolCallHandler(pi);
});

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

describe("handler registration", () => {
  it("registers exactly one tool_call handler", () => {
    expect(pi._handlers.get("tool_call")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bash — HTTP redirect
// ---------------------------------------------------------------------------

describe("Bash tool — HTTP commands", () => {
  it("blocks curl commands", async () => {
    const result = await pi.fire("tool_call", makeEvent("bash", { command: "curl https://example.com" }));
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("ctx_execute");
  });

  it("blocks wget commands", async () => {
    const result = await pi.fire("tool_call", makeEvent("bash", { command: "wget https://example.com/file" }));
    expect(result).toMatchObject({ block: true });
  });

  it("blocks bare requests.get outside shell-quoted strings", async () => {
    // The sanitiser strips quoted strings to avoid false positives on literal
    // string args (e.g. python3 -c "..."). The pattern fires when the token
    // appears directly in the command, not inside quotes.
    const result = await pi.fire("tool_call", makeEvent("bash", {
      command: "requests.get https://api.example.com",
    }));
    expect(result).toMatchObject({ block: true });
  });

  it("block reason is human-readable and mentions the blocked command", async () => {
    const cmd = "curl https://api.github.com/repos/foo/bar";
    const result = await pi.fire("tool_call", makeEvent("bash", { command: cmd })) as { reason: string };
    expect(result.reason).toContain("ctx_execute");
    // The reason should include the original command so the model knows what to redirect
    expect(result.reason).toContain(JSON.stringify(cmd));
  });

  it("does NOT block git commands", async () => {
    const result = await pi.fire("tool_call", makeEvent("bash", { command: "git commit -m 'test'" }));
    expect(result).toBeUndefined();
  });

  it("does NOT block ls/mkdir/rm commands", async () => {
    for (const cmd of ["ls -la", "mkdir -p dist", "rm -rf node_modules/.cache"]) {
      const result = await pi.fire("tool_call", makeEvent("bash", { command: cmd }));
      expect(result).toBeUndefined();
    }
  });

  it("sends BASH_GUIDANCE via sendMessage for non-blocked bash calls", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("bash", { command: "git status" }));
    const msgs = pi.sentMessages.map((m) => m.text);
    expect(msgs).toContain(BASH_GUIDANCE);
  });

  it("sends BASH_GUIDANCE with deliverAs:followUp", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("bash", { command: "git log --oneline -5" }));
    const bashMsg = pi.sentMessages.find((m) => m.text === BASH_GUIDANCE);
    expect((bashMsg?.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  it("handles the 'shell' alias", async () => {
    const result = await pi.fire("tool_call", makeEvent("shell", { command: "curl http://x.com" }));
    expect(result).toMatchObject({ block: true });
  });

  it("handles cmd param alias for command", async () => {
    const result = await pi.fire("tool_call", makeEvent("bash", { cmd: "wget http://x.com" }));
    expect(result).toMatchObject({ block: true });
  });
});

// ---------------------------------------------------------------------------
// WebFetch — always blocked
// ---------------------------------------------------------------------------

describe("WebFetch tool", () => {
  it("always blocks WebFetch", async () => {
    const result = await pi.fire("tool_call", makeEvent("WebFetch", { url: "https://example.com" }));
    expect(result).toMatchObject({ block: true });
  });

  it("block reason mentions ctx_fetch_and_index", async () => {
    const result = await pi.fire("tool_call", makeEvent("WebFetch", { url: "https://x.com" })) as { reason: string };
    expect(result.reason).toContain("ctx_fetch_and_index");
  });

  it("handles the web_fetch alias", async () => {
    const result = await pi.fire("tool_call", makeEvent("web_fetch", { url: "https://x.com" }));
    expect(result).toMatchObject({ block: true });
  });

  it("does NOT send extra messages for WebFetch (block is sufficient)", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("WebFetch", { url: "https://x.com" }));
    // No sendMessage calls — the block reason conveys all guidance
    expect(pi.sentMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Read tool — guidance via sendMessage
// ---------------------------------------------------------------------------

describe("Read tool", () => {
  it("does NOT block Read calls", async () => {
    const result = await pi.fire("tool_call", makeEvent("Read", { file_path: "src/index.ts" }));
    expect(result).toBeUndefined();
  });

  it("sends READ_GUIDANCE via sendMessage", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("Read", { file_path: "src/index.ts" }));
    const msgs = pi.sentMessages.map((m) => m.text);
    expect(msgs).toContain(READ_GUIDANCE);
  });

  it("sends READ_GUIDANCE with deliverAs:followUp", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("Read", { file_path: "README.md" }));
    const readMsg = pi.sentMessages.find((m) => m.text === READ_GUIDANCE);
    expect((readMsg?.options as { deliverAs?: string })?.deliverAs).toBe("followUp");
  });

  it("handles the read_file alias", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("read_file", { file_path: "x.ts" }));
    expect(pi.sentMessages.map((m) => m.text)).toContain(READ_GUIDANCE);
  });
});

// ---------------------------------------------------------------------------
// Grep tool — guidance via sendMessage
// ---------------------------------------------------------------------------

describe("Grep tool", () => {
  it("does NOT block Grep calls", async () => {
    const result = await pi.fire("tool_call", makeEvent("Grep", { pattern: "TODO", path: "src" }));
    expect(result).toBeUndefined();
  });

  it("sends GREP_GUIDANCE via sendMessage", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("Grep", { pattern: "TODO" }));
    const msgs = pi.sentMessages.map((m) => m.text);
    expect(msgs).toContain(GREP_GUIDANCE);
  });

  it("handles the 'search' alias", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("search", { pattern: "TODO" }));
    expect(pi.sentMessages.map((m) => m.text)).toContain(GREP_GUIDANCE);
  });
});

// ---------------------------------------------------------------------------
// Agent / Task tools — routing block injection
// ---------------------------------------------------------------------------

describe("Agent tool", () => {
  it("returns a modify object injecting ROUTING_BLOCK into the prompt", async () => {
    const result = await pi.fire("tool_call", makeEvent("agent", {
      prompt: "Refactor the auth module",
    })) as { modify: Record<string, unknown> };
    expect(result).toMatchObject({ modify: expect.any(Object) });
    expect(result.modify.prompt as string).toContain(ROUTING_BLOCK);
    expect(result.modify.prompt as string).toContain("Refactor the auth module");
  });

  it("injects into the 'description' param when no 'prompt' key", async () => {
    const result = await pi.fire("tool_call", makeEvent("agent", {
      description: "Analyse the codebase",
    })) as { modify: Record<string, unknown> };
    expect((result.modify.description as string)).toContain(ROUTING_BLOCK);
    expect((result.modify.description as string)).toContain("Analyse the codebase");
  });

  it("injects into the 'task' param when that key is used", async () => {
    const result = await pi.fire("tool_call", makeEvent("task", {
      task: "Write unit tests",
    })) as { modify: Record<string, unknown> };
    expect((result.modify.task as string)).toContain(ROUTING_BLOCK);
  });

  it("does NOT modify if prompt already contains routing block", async () => {
    const result = await pi.fire("tool_call", makeEvent("agent", {
      prompt: `Existing prompt\n\n${ROUTING_BLOCK}`,
    }));
    expect(result).toBeUndefined();
  });

  it("does NOT modify if ctx_batch_execute already present in prompt", async () => {
    const result = await pi.fire("tool_call", makeEvent("agent", {
      prompt: "Use ctx_batch_execute to run commands",
    }));
    expect(result).toBeUndefined();
  });

  it("handles spawn_agent alias", async () => {
    const result = await pi.fire("tool_call", makeEvent("spawn_agent", {
      prompt: "Help me test this",
    }));
    expect(result).toMatchObject({ modify: expect.any(Object) });
  });

  it("returns undefined if no recognisable prompt param", async () => {
    const result = await pi.fire("tool_call", makeEvent("agent", { config: "value" }));
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown tools — no-op
// ---------------------------------------------------------------------------

describe("unknown tools", () => {
  it("returns undefined for unrecognised tool names", async () => {
    const result = await pi.fire("tool_call", makeEvent("SomeFutureTool", { x: 1 }));
    expect(result).toBeUndefined();
  });

  it("does not send any messages for unknown tools", async () => {
    pi.sentMessages.length = 0;
    await pi.fire("tool_call", makeEvent("glob", { pattern: "**/*.ts" }));
    expect(pi.sentMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  it("returns undefined (does not throw) if toolName is missing", async () => {
    const result = await pi.fire("tool_call", { params: {}, toolCallId: "1" });
    expect(result).toBeUndefined();
  });
});
