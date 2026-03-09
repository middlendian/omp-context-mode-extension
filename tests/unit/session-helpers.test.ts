import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import {
  projectHash,
  getSessionDBPath,
  getSessionEventsPath,
  getCleanupFlagPath,
  getContextModeDir,
  getSessionsDir,
  deriveSessionId,
} from "../../src/session/helpers.js";

describe("projectHash", () => {
  it("returns a 16-char lowercase hex string", () => {
    const hash = projectHash("/home/user/myproject");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable — same dir always yields same hash", () => {
    const a = projectHash("/home/user/foo");
    const b = projectHash("/home/user/foo");
    expect(a).toBe(b);
  });

  it("is different for different dirs", () => {
    const a = projectHash("/home/user/foo");
    const b = projectHash("/home/user/bar");
    expect(a).not.toBe(b);
  });

  it("is case-sensitive", () => {
    expect(projectHash("/Foo")).not.toBe(projectHash("/foo"));
  });
});

describe("getContextModeDir", () => {
  it("returns path inside the home directory", () => {
    const dir = getContextModeDir();
    expect(dir.startsWith(os.homedir())).toBe(true);
  });

  it("contains 'context-mode'", () => {
    expect(getContextModeDir()).toContain("context-mode");
  });
});

describe("getSessionsDir", () => {
  it("is a subdirectory of getContextModeDir", () => {
    const sessionsDir = getSessionsDir();
    expect(sessionsDir.startsWith(getContextModeDir())).toBe(true);
  });
});

describe("getSessionDBPath", () => {
  it("ends with .db", () => {
    expect(getSessionDBPath("/some/project")).toMatch(/\.db$/);
  });

  it("includes the project hash in the filename", () => {
    const dir = "/my/project";
    const dbPath = getSessionDBPath(dir);
    expect(path.basename(dbPath)).toBe(`${projectHash(dir)}.db`);
  });

  it("is inside getSessionsDir()", () => {
    const dbPath = getSessionDBPath("/any/dir");
    expect(dbPath.startsWith(getSessionsDir())).toBe(true);
  });

  it("is different for different project dirs", () => {
    const a = getSessionDBPath("/proj/a");
    const b = getSessionDBPath("/proj/b");
    expect(a).not.toBe(b);
  });
});

describe("getSessionEventsPath", () => {
  it("ends with -events.md", () => {
    expect(getSessionEventsPath("/proj")).toMatch(/-events\.md$/);
  });

  it("shares the same hash prefix as the DB path", () => {
    const dir = "/shared/project";
    const hash = projectHash(dir);
    expect(getSessionEventsPath(dir)).toContain(hash);
    expect(getSessionDBPath(dir)).toContain(hash);
  });
});

describe("getCleanupFlagPath", () => {
  it("starts with 'cleanup-' in the filename", () => {
    const flagPath = getCleanupFlagPath("/proj");
    expect(path.basename(flagPath)).toMatch(/^cleanup-/);
  });

  it("is inside getContextModeDir()", () => {
    const flagPath = getCleanupFlagPath("/proj");
    expect(flagPath.startsWith(getContextModeDir())).toBe(true);
  });
});

describe("deriveSessionId", () => {
  it("returns the provided OMP session ID when given one", () => {
    const id = deriveSessionId("omp-session-abc-123", "/proj");
    expect(id).toBe("omp-session-abc-123");
  });

  it("returns a fallback ID when OMP session ID is undefined", () => {
    const id = deriveSessionId(undefined, "/my/project");
    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");
  });

  it("fallback includes the project hash", () => {
    const dir = "/my/project";
    const id = deriveSessionId(undefined, dir);
    expect(id.startsWith(projectHash(dir))).toBe(true);
  });

  it("fallback is stable within the same 1-hour bucket", () => {
    const a = deriveSessionId(undefined, "/proj");
    const b = deriveSessionId(undefined, "/proj");
    expect(a).toBe(b);
  });

  it("fallback differs for different project dirs", () => {
    const a = deriveSessionId(undefined, "/proj/a");
    const b = deriveSessionId(undefined, "/proj/b");
    expect(a).not.toBe(b);
  });
});
