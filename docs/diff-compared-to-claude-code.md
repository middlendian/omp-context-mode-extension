# Differences from the Claude Code implementation

This document compares the OMP extension's implementation of context-mode
integration against the original Claude Code hooks implementation. It exists
to help maintainers understand which parts are faithful ports, which are
OMP-specific shims, and where behaviour diverges.

The Claude Code hooks implementation lives in the `context-mode` repository
under `src/hooks/` (not publicly exported from the npm package).

---

## Hook system — API surface

| Concept | Claude Code | OMP |
|---|---|---|
| Hook registration | JSON config in `~/.claude/hooks/` | `pi.on(event, handler)` in extension module |
| Hook file location | Per-hook shell scripts or node scripts | Single extension module (`dist/index.js`) |
| Handler return to block | `{ decision: "block", reason: "..." }` | `{ block: true, reason: "..." }` |
| Handler return to allow | `{ decision: "allow" }` or no return | `undefined` / no return |
| Handler return to modify | `{ decision: "allow", modifiedInput: {...} }` | `{ modify: {...} }` (speculative — verify at runtime) |
| Message injection | `outputText` field in hook output JSON | `pi.sendMessage(text, { deliverAs })` |

### `deliverAs` — OMP-specific

Claude Code has no direct equivalent of OMP's `deliverAs` option.
In Claude Code, hooks output text synchronously and it is injected inline.
OMP's `deliverAs` controls *when* the message is delivered:

| `deliverAs` value | Behaviour |
|---|---|
| `"nextTurn"` | Injected as the first message of the next agent turn |
| `"followUp"` | Queued after the current turn completes |
| `"steer"` | Interrupts the current turn immediately |

We use `"nextTurn"` for session directives and routing blocks, and `"followUp"`
for per-tool guidance nudges (Read, Grep, Bash).

---

## Lifecycle event mapping

| Claude Code hook | OMP event | Notes |
|---|---|---|
| `PreToolUse` | `tool_call` | Identical concept; return shape differs (see above) |
| `PostToolUse` | `tool_result` | Identical concept |
| `UserPromptSubmit` | `input` | Identical concept |
| `PreCompact` | `session_before_compact` | OMP event payload is richer (see below) |
| `SessionStart` | `session_start` | OMP adds `sessionType` enum |
| *(none)* | `session_shutdown` | OMP-only; used to tear down the MCP subprocess |
| *(none)* | `model_select` | OMP-only |

### `session_before_compact` payload — richer in OMP

OMP's event payload includes fields that Claude Code's `PreCompact` hook does
not provide:

```typescript
interface SessionCompactEvent {
  messagesToSummarize?: unknown[];   // messages being summarised
  turnPrefixMessages?: unknown[];    // verbatim turn prefix
  tokensBefore?: number;             // token count before compaction
  firstKeptEntryId?: string;         // oldest kept message ID
  previousSummary?: string;          // prior summary text
  signal?: AbortSignal;              // honour for async work
}
```

Our `pre-compact.ts` handler currently ignores all of these — it reads events
from the DB instead — but they are typed in `src/types.ts` for future use.

### `session_start` — `sessionType` is OMP-specific

Claude Code does not pass a `sessionType` to session start hooks.
OMP provides four values:

| `sessionType` | Meaning | Our response |
|---|---|---|
| `"startup"` | Fresh session | Purge old DB data, capture rule files, inject ROUTING_BLOCK |
| `"compact"` | Resumed after auto-compaction | Inject snapshot directive from DB |
| `"resume"` | User ran `--continue` | Inject task/file/error summary from DB |
| `"clear"` | User cleared context | Set cleanup flag, inject ROUTING_BLOCK |

---

## Tool name casing

Claude Code tool names are **lowercase** (`bash`, `read`, `grep`).
OMP tool names are **PascalCase** (`Bash`, `Read`, `Grep`).

Our `tool_call` handler normalises names with `.toLowerCase()` so the routing
logic is case-insensitive, but the aliases we check do reflect both
conventions:

```typescript
if (name === "bash" || name === "shell") ...         // covers both
if (name === "webfetch" || name === "web_fetch") ...
if (name === "read" || name === "read_file") ...
if (name === "grep" || name === "search") ...
```

---

## Rule file locations

| Claude Code | OMP (this extension) |
|---|---|
| `CLAUDE.md` (project root) | `AGENT.md`, `agent.md` |
| `~/.claude/CLAUDE.md` (global) | `~/.local/share/omp/AGENT.md` (OMP global, not implemented) |
| *(none)* | `.omp/RULES.md`, `.omp/rules.md` |
| *(none)* | `CLAUDE.md` (backward-compatible fallback) |

The `captureRuleFiles()` function in `session-start.ts` reads these files into
the DB for indexing. It does **not** inject them into the prompt directly —
that is handled by OMP's own rule-injection mechanism. The DB copy exists so
`ctx_search` can find rules when the model asks about project conventions.

---

## Session ID derivation — OMP shim

Claude Code sessions have a stable UUID assigned by the platform.
OMP sessions have a stable ID provided by `ctx.sessionId` (or `event.sessionId`),
but this is not always present.

Our fallback in `src/session/helpers.ts`:

```typescript
// 1-hour bucket derived from projectDir hash
const bucket = Math.floor(Date.now() / 3_600_000);
return `${projectHash(projectDir)}-${bucket}`;
```

This means two OMP sessions started in the same hour for the same project share
the same logical session ID and hence the same DB row. This is intentional —
it prevents spurious "new session" events from fragmenting history when OMP
restarts quickly. The downside: if two parallel OMP sessions run in the same
project in the same hour, they write to the same row. This is an unlikely edge
case in normal use.

Claude Code does not have this fallback because session IDs are always present.

---

## SQLite session database — OMP/context-mode shim (no Claude Code equivalent)

Claude Code has no persistent session database. Context continuity across
compaction in Claude Code is handled by the platform's built-in summarisation.

Our DB exists entirely because:
1. `context-mode` (the MCP server) maintains session state in SQLite
2. The OMP hooks need to write events that `ctx_search` / `ctx_stats` can read
3. The compaction snapshot must be persisted between the `pre_compact` hook
   and the subsequent `session_start` hook

The schema mirrors `context-mode/src/store.ts` (not publicly exported).
See `docs/how-to-update-context-mode.md` for the schema maintenance process.

The DB is located at:

```
~/.claude/context-mode/sessions/{sha256(projectDir)[0:16]}.db
```

The path uses `.claude` (Claude Code's platform config directory) as the root
because context-mode was originally built for Claude Code and defaults to that
path. We pass `CLAUDE_PROJECT_DIR` when spawning the subprocess to ensure both
our hooks and the MCP server use the same file.

---

## HTTP interception — behaviour difference

Claude Code's original context-mode hook intercepts `Bash` at the shell level
(wrapping curl/wget in a sandbox). Our implementation returns `{ block: true }`
from the `tool_call` handler, which prevents the tool from running at all and
instructs the model to use `ctx_execute` instead.

This is **more aggressive** than the Claude Code implementation (which
redirects rather than blocks), but avoids the shell wrapping complexity and is
more appropriate for OMP's tool model.

---

## Context injection method — key difference

In Claude Code, hooks can inject context by including an `outputText` field in
their JSON response. This text appears in-context immediately.

In OMP, there is no documented `{ context: string }` return type for
`tool_call`. Instead we use `pi.sendMessage(text, { deliverAs: "followUp" })`
for non-blocking guidance (Read, Grep, Bash hints). This means the guidance
arrives in the *next* message slot rather than inline with the tool call, which
is slightly different timing but functionally equivalent.

---

## MCP server lifecycle — OMP-specific

Claude Code has native MCP support configured via `claude.json`. Extensions
do not need to manage MCP server processes.

In OMP, MCP servers are either:
- Configured statically in OMP settings (`mcpServers` key)
- Spawned by extensions at runtime (our approach)

We chose the runtime-spawn approach because it lets us pass `CLAUDE_PROJECT_DIR`
dynamically at session start, which is required for the per-project DB path.
The trade-off is that the `ctx_*` tools are unavailable until the first
`session_start` event fires and the subprocess connects.

---

## What this extension does NOT implement from Claude Code context-mode

| Feature | Status | Reason |
|---|---|---|
| Shell-level command wrapping | Not implemented | OMP blocks at tool level instead |
| `ctx upgrade` auto-update | Not implemented | We version-pin; upgrades are intentional |
| `ctx doctor` hook status check | Not implemented | OMP has no equivalent diagnostic surface |
| Global rule file (`~/.claude/CLAUDE.md`) | Not implemented | OMP global config path differs; low priority |
| Parallel session support | Not implemented | Fallback session ID assumes single session per project-hour |
| `context` event (modify messages array) | Not implemented | OMP uses `pi.sendMessage()` instead |
