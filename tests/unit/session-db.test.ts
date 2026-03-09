import { describe, it, expect, beforeEach } from "vitest";
import {
  SessionDB,
  extractToolEvents,
  extractPromptEvents,
  clearSessionDBCache,
} from "../../src/session/db.js";

// Use ":memory:" so tests never touch ~/.claude/...
const PROJECT_DIR = "/test/project";

function makeDB(): SessionDB {
  return new SessionDB(PROJECT_DIR, ":memory:");
}

beforeEach(() => {
  clearSessionDBCache();
});

// ---------------------------------------------------------------------------
// SessionDB — session management
// ---------------------------------------------------------------------------

describe("SessionDB.ensureSession", () => {
  it("creates a session row", () => {
    const db = makeDB();
    db.ensureSession("sess-1", PROJECT_DIR);
    const s = db.getSession("sess-1");
    expect(s).toBeDefined();
    expect(s?.id).toBe("sess-1");
    expect(s?.projectDir).toBe(PROJECT_DIR);
    expect(s?.compactCount).toBe(0);
    expect(s?.cleanupFlag).toBe(0);
  });

  it("is idempotent — calling twice does not throw or duplicate", () => {
    const db = makeDB();
    db.ensureSession("sess-2", PROJECT_DIR);
    expect(() => db.ensureSession("sess-2", PROJECT_DIR)).not.toThrow();
    expect(db.getSession("sess-2")).toBeDefined();
  });
});

describe("SessionDB.getLatestSession", () => {
  it("returns undefined when no sessions exist", () => {
    const db = makeDB();
    expect(db.getLatestSession()).toBeUndefined();
  });

  it("returns the most recently created session", () => {
    const db = makeDB();
    db.ensureSession("old", PROJECT_DIR);
    // Small delay to ensure different createdAt
    db["db"].prepare("UPDATE sessions SET createdAt = 1 WHERE id = 'old'").run();
    db.ensureSession("new", PROJECT_DIR);
    db["db"].prepare("UPDATE sessions SET createdAt = 9999999999999 WHERE id = 'new'").run();
    expect(db.getLatestSession()?.id).toBe("new");
  });
});

describe("SessionDB.incrementCompactCount", () => {
  it("increments the compact counter", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    db.incrementCompactCount("sess");
    db.incrementCompactCount("sess");
    expect(db.getSession("sess")?.compactCount).toBe(2);
  });
});

describe("SessionDB.setCleanupFlag", () => {
  it("sets the cleanup flag", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    db.setCleanupFlag("sess", 1);
    expect(db.getSession("sess")?.cleanupFlag).toBe(1);
    db.setCleanupFlag("sess", 0);
    expect(db.getSession("sess")?.cleanupFlag).toBe(0);
  });
});

describe("SessionDB.deleteOldSessions", () => {
  it("removes all sessions except the kept one", () => {
    const db = makeDB();
    db.ensureSession("keep", PROJECT_DIR);
    db.ensureSession("old1", PROJECT_DIR);
    db.ensureSession("old2", PROJECT_DIR);
    db.deleteOldSessions("keep");
    expect(db.getSession("keep")).toBeDefined();
    expect(db.getSession("old1")).toBeUndefined();
    expect(db.getSession("old2")).toBeUndefined();
  });

  it("also removes events for deleted sessions", () => {
    const db = makeDB();
    db.ensureSession("keep", PROJECT_DIR);
    db.ensureSession("old", PROJECT_DIR);
    db.addEvent({ sessionId: "old", eventType: "user_prompt", data: "hello", timestamp: 1 });
    db.deleteOldSessions("keep");
    expect(db.getEvents("old")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SessionDB — events
// ---------------------------------------------------------------------------

describe("SessionDB events", () => {
  it("roundtrips an event via addEvent/getEvents", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    db.addEvent({ sessionId: "sess", eventType: "user_prompt", data: "hello", timestamp: 123 });
    const evs = db.getEvents("sess");
    expect(evs).toHaveLength(1);
    expect(evs[0].eventType).toBe("user_prompt");
    expect(evs[0].data).toBe("hello");
    expect(evs[0].timestamp).toBe(123);
  });

  it("returns events ordered by timestamp ascending", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    db.addEvent({ sessionId: "sess", eventType: "error", data: "later", timestamp: 200 });
    db.addEvent({ sessionId: "sess", eventType: "error", data: "earlier", timestamp: 100 });
    const evs = db.getEvents("sess");
    expect(evs[0].data).toBe("earlier");
    expect(evs[1].data).toBe("later");
  });

  it("returns empty array for unknown session", () => {
    const db = makeDB();
    expect(db.getEvents("nonexistent")).toHaveLength(0);
  });

  it("getLatestEvents limits results", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    for (let i = 0; i < 10; i++) {
      db.addEvent({ sessionId: "sess", eventType: "user_prompt", data: `msg-${i}`, timestamp: i });
    }
    expect(db.getLatestEvents(3)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// SessionDB — snapshots
// ---------------------------------------------------------------------------

describe("SessionDB snapshots", () => {
  it("roundtrips a snapshot via saveSnapshot/getSnapshot", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    db.saveSnapshot("sess", "<session-resume/>");
    const snap = db.getSnapshot("sess");
    expect(snap?.snapshotXml).toBe("<session-resume/>");
    expect(snap?.sessionId).toBe("sess");
  });

  it("returns undefined for missing snapshot", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    expect(db.getSnapshot("sess")).toBeUndefined();
  });

  it("replaces an existing snapshot on second save", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    db.saveSnapshot("sess", "<v1/>");
    db.saveSnapshot("sess", "<v2/>");
    expect(db.getSnapshot("sess")?.snapshotXml).toBe("<v2/>");
  });
});

// ---------------------------------------------------------------------------
// SessionDB — rule files
// ---------------------------------------------------------------------------

describe("SessionDB.saveRuleFile", () => {
  it("stores rule file content without error", () => {
    const db = makeDB();
    db.ensureSession("sess", PROJECT_DIR);
    expect(() =>
      db.saveRuleFile("sess", "/project/AGENT.md", "# Rules\n- be helpful"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractToolEvents
// ---------------------------------------------------------------------------

describe("extractToolEvents", () => {
  describe("file edit/write tools", () => {
    it("emits file_modified for Edit with file_path param", () => {
      const evs = extractToolEvents("Edit", { file_path: "src/foo.ts" });
      expect(evs).toContainEqual({ eventType: "file_modified", data: "src/foo.ts" });
    });

    it("emits file_modified for Write with path param", () => {
      const evs = extractToolEvents("Write", { path: "README.md" });
      expect(evs).toContainEqual({ eventType: "file_modified", data: "README.md" });
    });

    it("emits file_modified for MultiEdit", () => {
      const evs = extractToolEvents("MultiEdit", { filePath: "lib/utils.ts" });
      expect(evs).toContainEqual({ eventType: "file_modified", data: "lib/utils.ts" });
    });

    it("skips file_modified when no file path present", () => {
      const evs = extractToolEvents("Edit", { content: "only content" });
      expect(evs.filter((e) => e.eventType === "file_modified")).toHaveLength(0);
    });
  });

  describe("bash / shell tools", () => {
    it("emits git_operation for git commit", () => {
      const evs = extractToolEvents("bash", { command: "git commit -m 'fix'" });
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "git_operation" }),
      );
    });

    it("emits git_operation for git push", () => {
      const evs = extractToolEvents("bash", { command: "git push origin main" });
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "git_operation" }),
      );
    });

    it("emits git_operation for git pull", () => {
      const evs = extractToolEvents("bash", { command: "git pull" });
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "git_operation" }),
      );
    });

    it("emits git_operation for git merge", () => {
      const evs = extractToolEvents("bash", { command: "git merge feature-branch" });
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "git_operation" }),
      );
    });

    it("does not emit git_operation for non-git commands", () => {
      const evs = extractToolEvents("bash", { command: "ls -la" });
      expect(evs.filter((e) => e.eventType === "git_operation")).toHaveLength(0);
    });

    it("emits error event when result contains 'error'", () => {
      const evs = extractToolEvents("bash", { command: "tsc" }, "error: cannot find module");
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "error" }),
      );
    });

    it("emits error event when result contains 'failed'", () => {
      const evs = extractToolEvents("bash", { command: "npm test" }, "tests failed: 3");
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "error" }),
      );
    });

    it("does not emit spurious error for 'true'/'false' results", () => {
      const evs = extractToolEvents("bash", { command: "test -f file" }, "false");
      expect(evs.filter((e) => e.eventType === "error")).toHaveLength(0);
    });
  });

  describe("TodoWrite tool", () => {
    it("emits task event for TodoWrite", () => {
      const evs = extractToolEvents("TodoWrite", { todos: ["implement X"] });
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "task" }),
      );
    });

    it("emits task event for todo_write variant", () => {
      const evs = extractToolEvents("todo_write", { todos: [] });
      expect(evs).toContainEqual(
        expect.objectContaining({ eventType: "task" }),
      );
    });
  });

  it("returns empty array for unrecognised tools", () => {
    expect(extractToolEvents("SomeTool", { x: 1 })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// extractPromptEvents
// ---------------------------------------------------------------------------

describe("extractPromptEvents", () => {
  it("emits decision for 'don't do that'", () => {
    const evs = extractPromptEvents("don't do that");
    expect(evs).toContainEqual(expect.objectContaining({ eventType: "decision" }));
  });

  it("emits decision for 'never use lodash'", () => {
    const evs = extractPromptEvents("never use lodash in this project");
    expect(evs).toContainEqual(expect.objectContaining({ eventType: "decision" }));
  });

  it("emits decision for 'actually, use vitest'", () => {
    const evs = extractPromptEvents("actually, use vitest not jest");
    expect(evs).toContainEqual(expect.objectContaining({ eventType: "decision" }));
  });

  it("emits decision for 'no, wrong approach'", () => {
    const evs = extractPromptEvents("no, that's wrong");
    expect(evs).toContainEqual(expect.objectContaining({ eventType: "decision" }));
  });

  it("emits decision for 'instead, do X'", () => {
    const evs = extractPromptEvents("instead, import from the utils module");
    expect(evs).toContainEqual(expect.objectContaining({ eventType: "decision" }));
  });

  it("returns empty array for neutral prompts", () => {
    const evs = extractPromptEvents("what is the capital of France?");
    expect(evs).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    expect(extractPromptEvents("")).toHaveLength(0);
  });
});
