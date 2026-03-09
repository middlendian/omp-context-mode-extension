import { describe, it, expect } from "vitest";
import {
  ROUTING_BLOCK,
  READ_GUIDANCE,
  BASH_GUIDANCE,
  GREP_GUIDANCE,
  buildSessionSnapshot,
  buildSessionDirective,
  type SnapshotEvent,
} from "../../src/routing.js";

// ---------------------------------------------------------------------------
// Guidance constants
// ---------------------------------------------------------------------------

describe("guidance constants", () => {
  it("ROUTING_BLOCK mentions ctx_batch_execute", () => {
    expect(ROUTING_BLOCK).toContain("ctx_batch_execute");
  });

  it("ROUTING_BLOCK mentions ctx_fetch_and_index", () => {
    expect(ROUTING_BLOCK).toContain("ctx_fetch_and_index");
  });

  it("ROUTING_BLOCK mentions WebFetch as forbidden", () => {
    expect(ROUTING_BLOCK).toContain("WebFetch");
  });

  it("READ_GUIDANCE mentions ctx_execute_file", () => {
    expect(READ_GUIDANCE).toContain("ctx_execute_file");
  });

  it("BASH_GUIDANCE mentions ctx_batch_execute", () => {
    expect(BASH_GUIDANCE).toContain("ctx_batch_execute");
  });

  it("GREP_GUIDANCE mentions ctx_search", () => {
    expect(GREP_GUIDANCE).toContain("ctx_search");
  });
});

// ---------------------------------------------------------------------------
// buildSessionSnapshot
// ---------------------------------------------------------------------------

describe("buildSessionSnapshot", () => {
  it("returns empty session-resume tag for no events", () => {
    const xml = buildSessionSnapshot([]);
    expect(xml).toBe("<session-resume>\n</session-resume>");
  });

  it("includes modified_files section for file_modified events", () => {
    const events: SnapshotEvent[] = [
      { eventType: "file_modified", data: "src/index.ts", timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).toContain("<modified_files>");
    expect(xml).toContain("src/index.ts");
    expect(xml).toContain("</modified_files>");
  });

  it("includes pending_tasks section for task events", () => {
    const events: SnapshotEvent[] = [
      { eventType: "task", data: "implement feature X", timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).toContain("<pending_tasks>");
    expect(xml).toContain("implement feature X");
  });

  it("includes unresolved_errors section for error events", () => {
    const events: SnapshotEvent[] = [
      { eventType: "error", data: "TypeError: cannot read property", timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).toContain("<unresolved_errors>");
    expect(xml).toContain("TypeError");
  });

  it("includes git_operations section for git_operation events", () => {
    const events: SnapshotEvent[] = [
      { eventType: "git_operation", data: "git commit -m 'fix: bug'", timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).toContain("<git_operations>");
  });

  it("includes key_decisions section for decision events", () => {
    const events: SnapshotEvent[] = [
      { eventType: "decision", data: "don't use lodash", timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).toContain("<key_decisions>");
  });

  it("excludes sections with no events", () => {
    const events: SnapshotEvent[] = [
      { eventType: "file_modified", data: "a.ts", timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).not.toContain("<pending_tasks>");
    expect(xml).not.toContain("<unresolved_errors>");
  });

  it("keeps only the last 10 events per category", () => {
    const events: SnapshotEvent[] = Array.from({ length: 15 }, (_, i) => ({
      eventType: "file_modified" as const,
      data: `file-${i}.ts`,
      timestamp: i,
    }));
    const xml = buildSessionSnapshot(events);
    // Should contain the last 10 (file-5 through file-14)
    expect(xml).toContain("file-14.ts");
    expect(xml).not.toContain("file-4.ts");
  });

  it("escapes XML special characters in data", () => {
    const events: SnapshotEvent[] = [
      { eventType: "error", data: 'a < b && c > d "quoted"', timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&quot;");
    // Raw unescaped < and > must not appear inside item content
    const itemContent = xml.match(/<item>(.*?)<\/item>/)?.[1] ?? "";
    expect(itemContent).not.toContain("<");
    expect(itemContent).not.toContain(">");
  });

  it("truncates data at 120 chars per item", () => {
    const longData = "x".repeat(200);
    const events: SnapshotEvent[] = [
      { eventType: "error", data: longData, timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    // 120 x's (not 200)
    expect(xml).toContain("x".repeat(120));
    expect(xml).not.toContain("x".repeat(121));
  });

  it("truncates total output at ~2 KB", () => {
    // Create events across multiple categories so total XML exceeds 2000 chars.
    // Each item takes ~135 chars; 10 items × 6 categories ≈ 8100 chars — well over limit.
    const makeEvents = (type: SnapshotEvent["eventType"]): SnapshotEvent[] =>
      Array.from({ length: 10 }, (_, i) => ({
        eventType: type,
        data: `${"z".repeat(110)} ${i}`,
        timestamp: i,
      }));
    const events: SnapshotEvent[] = [
      ...makeEvents("error"),
      ...makeEvents("file_modified"),
      ...makeEvents("git_operation"),
      ...makeEvents("task"),
      ...makeEvents("decision"),
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml.length).toBeLessThanOrEqual(2000);
    expect(xml).toContain("<!-- truncated -->");
    expect(xml).toContain("</session-resume>");
  });

  it("ignores unknown event types", () => {
    const events: SnapshotEvent[] = [
      { eventType: "unknown_type", data: "ignored", timestamp: 1 },
    ];
    const xml = buildSessionSnapshot(events);
    expect(xml).not.toContain("ignored");
    expect(xml).toBe("<session-resume>\n</session-resume>");
  });
});

// ---------------------------------------------------------------------------
// buildSessionDirective
// ---------------------------------------------------------------------------

describe("buildSessionDirective", () => {
  it("wraps snapshot in session-directive tags", () => {
    const directive = buildSessionDirective("<session-resume></session-resume>", "/my/project");
    expect(directive).toContain("<session-directive>");
    expect(directive).toContain("</session-directive>");
  });

  it("includes the project dir", () => {
    const directive = buildSessionDirective("snap", "/home/user/myproject");
    expect(directive).toContain("/home/user/myproject");
  });

  it("includes the snapshot content", () => {
    const snapshot = "<session-resume><pending_tasks><item>do x</item></pending_tasks></session-resume>";
    const directive = buildSessionDirective(snapshot, "/proj");
    expect(directive).toContain(snapshot);
  });

  it("mentions ctx_search as a way to retrieve history", () => {
    const directive = buildSessionDirective("snap", "/proj");
    expect(directive).toContain("ctx_search");
  });
});
