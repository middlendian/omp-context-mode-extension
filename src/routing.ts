/**
 * Routing instructions injected at session start and via the `context` event.
 *
 * Port of context-mode's routing-block.mjs adapted for OMP's tool names
 * (Bash instead of bash, Read instead of read_file, etc.).
 */

// ---------------------------------------------------------------------------
// Core routing block — injected once per session
// ---------------------------------------------------------------------------

export const ROUTING_BLOCK = `
<context-mode-rules>
## Context Mode — Rules of Engagement

You have access to context-mode MCP tools that dramatically reduce token usage
by running code and searching through a sandboxed index rather than pulling raw
data into the conversation.

### Primary research tool
Use **ctx_batch_execute** as your default research tool. It runs multiple
shell commands and search queries in one call and returns only stdout, keeping
raw output out of the conversation window.

### Follow-up queries
Use **ctx_search** to query previously indexed content with BM25 + fuzzy
matching. Prefer this over re-running commands for data you've already seen.

### File processing
Use **ctx_execute_file** to process or analyse a file without exposing its raw
content. Use **ctx_execute** for short inline scripts.

### Web content
Use **ctx_fetch_and_index** instead of any direct web fetch. It fetches,
converts to markdown, chunks, and indexes in one operation.

### Forbidden patterns (prefer sandboxed alternatives)
- **Bash** for commands that produce >20 lines of output → use ctx_batch_execute
- **Read** for analysing file content → use ctx_execute_file
- **WebFetch** → use ctx_fetch_and_index

### Output discipline
- Keep responses under 500 words.
- Write long content (reports, diffs, summaries) to a file, not inline.

### Utility commands
- \`ctx stats\`   → context savings and session metrics
- \`ctx doctor\`  → runtime diagnostics and hook status
- \`ctx upgrade\` → update context-mode to the latest version
</context-mode-rules>
`.trim();

// ---------------------------------------------------------------------------
// Per-tool guidance (injected as additionalContext on specific tool events)
// ---------------------------------------------------------------------------

export const READ_GUIDANCE = `
context-mode hint: Use ctx_execute_file to analyse this file without
exposing raw content to the conversation. Only use Read when you need to
make an edit to this file.
`.trim();

export const BASH_GUIDANCE = `
context-mode hint: If this command produces more than ~20 lines, use
ctx_batch_execute instead. Reserve Bash for git, mkdir, rm, mv, and
directory navigation.
`.trim();

export const GREP_GUIDANCE = `
context-mode hint: For broad codebase searches, prefer ctx_batch_execute
or ctx_search over Grep — they stay out of the conversation context.
`.trim();

// ---------------------------------------------------------------------------
// Session resume snapshot builder
// ---------------------------------------------------------------------------

export type EventPriority = "critical" | "high" | "medium";

export interface SnapshotEvent {
  eventType: string;
  data: string;
  timestamp: number;
}

interface PriorityGroup {
  label: string;
  events: SnapshotEvent[];
}

const PRIORITY: Record<string, EventPriority> = {
  task: "critical",
  file_modified: "critical",
  git_operation: "high",
  error: "high",
  decision: "high",
  environment_change: "high",
  user_prompt: "medium",
  plan_mode: "medium",
};

/**
 * Build a compact (<2 KB) XML snapshot from recent session events.
 * Mirrors context-mode's buildSessionSnapshot().
 */
export function buildSessionSnapshot(events: SnapshotEvent[]): string {
  const groups: Record<string, PriorityGroup> = {
    task: { label: "Pending Tasks", events: [] },
    file_modified: { label: "Modified Files", events: [] },
    git_operation: { label: "Git Operations", events: [] },
    error: { label: "Unresolved Errors", events: [] },
    decision: { label: "Key Decisions", events: [] },
    environment_change: { label: "Environment Changes", events: [] },
  };

  for (const ev of events) {
    const group = groups[ev.eventType];
    if (group) group.events.push(ev);
  }

  let xml = "<session-resume>\n";

  for (const [, group] of Object.entries(groups)) {
    if (group.events.length === 0) continue;
    const tag = group.label.replace(/\s+/g, "_").toLowerCase();
    xml += `  <${tag}>\n`;
    for (const ev of group.events.slice(-10)) {
      const text = ev.data.slice(0, 120).replace(/[<>&"]/g, (c) =>
        ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c),
      );
      xml += `    <item>${text}</item>\n`;
    }
    xml += `  </${tag}>\n`;
  }

  xml += "</session-resume>";

  // Hard cap at ~2 KB — trim older entries if needed
  if (xml.length > 2000) {
    return xml.slice(0, 1950) + "\n  <!-- truncated -->\n</session-resume>";
  }

  return xml;
}

/**
 * Build a session directive narrative for injection after compaction.
 * Mirrors context-mode's buildSessionDirective().
 */
export function buildSessionDirective(snapshot: string, projectDir: string): string {
  return `
<session-directive>
Your context was compacted. The following snapshot captures the most important
state from before compaction. Resume from exactly this point.

${snapshot}

To retrieve full history, run: ctx_search("recent changes") or
ctx_batch_execute(["grep -r TODO . --include='*.ts' -l"])

Project: ${projectDir}
</session-directive>
`.trim();
}
