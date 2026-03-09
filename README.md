# omp-context-mode

An [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) extension that integrates [context-mode](https://github.com/mksglu/context-mode) — saving up to **98% of your context window** through sandboxed execution and session continuity across compactions.

## What it does

| Feature | How it works in OMP |
|---------|---------------------|
| **Sandboxed execution** | Spawns the context-mode MCP server; registers `ctx_execute`, `ctx_batch_execute`, `ctx_execute_file`, `ctx_index`, `ctx_search`, `ctx_fetch_and_index`, `ctx_stats`, `ctx_doctor`, `ctx_upgrade` as native OMP tools |
| **Routing enforcement** | `tool_call` handler blocks raw `curl`/`wget`/`WebFetch` and redirects them to sandbox tools |
| **Session continuity** | `session_start` / `session_before_compact` handlers persist events to SQLite and restore a prioritised snapshot after context compaction |
| **User prompt capture** | `input` handler records each user turn (decisions, corrections) for retrieval via `ctx_search` |
| **Per-tool guidance** | Injects context hints on `Read` and `Grep` tool calls, steering the model toward sandbox alternatives |
| **Sub-agent routing** | Patches `agent`/`task` prompts to include routing instructions so child agents also use sandbox tools |

## Requirements

- **oh-my-pi** installed (`npm install -g oh-my-pi` or from the OMP repo)
- **Node.js ≥ 18** (for `npx`)
- **context-mode** reachable via `npx` (installed automatically on first use)

## Installation

### Option A — from npm (recommended)

```sh
# Install the extension package
npm install -g omp-context-mode

# Register it with OMP (adds to ~/.omp/agent/extensions/)
omp extension add omp-context-mode
```

### Option B — from source

```sh
git clone https://github.com/YOUR_ORG/omp-context-mode-extension
cd omp-context-mode-extension
npm install
npm run build

# Point OMP at the built extension
omp extension add ./dist/index.js
# or copy to the user extensions directory:
mkdir -p ~/.omp/agent/extensions/omp-context-mode
cp -r dist package.json ~/.omp/agent/extensions/omp-context-mode/
```

### Option C — project-level (per-repo)

Drop this into your project root:

```sh
git clone https://github.com/YOUR_ORG/omp-context-mode-extension .omp/extensions/context-mode
cd .omp/extensions/context-mode
npm install && npm run build
```

OMP auto-discovers extensions in `<cwd>/.omp/extensions/`.

---

## How it integrates with context-mode

The extension uses the **MCP server from context-mode as-is** — it is spawned as a subprocess via `npx context-mode` over stdio. No patching or forking is required.

Session data (`~/.claude/context-mode/sessions/<project-hash>.db`) is shared between:
- The MCP server subprocess (reads/writes via `ctx_stats`, `ctx_search`, etc.)
- The OMP extension hooks (write events on tool calls, read snapshot on resume)

This means `ctx_stats` accurately reflects the savings achieved within OMP sessions, and `ctx_search` can retrieve the full event history.

---

## Available tools (registered in OMP)

| Tool | Description |
|------|-------------|
| `ctx_execute` | Run code in 11 languages in a subprocess; only stdout enters context |
| `ctx_execute_file` | Process a file in sandbox without exposing raw content |
| `ctx_batch_execute` | Run multiple shell commands / search queries in one call |
| `ctx_index` | Chunk markdown into FTS5 database with BM25 ranking |
| `ctx_search` | Query indexed content with fuzzy fallback (stemming, trigram, Levenshtein) |
| `ctx_fetch_and_index` | Fetch a URL, convert to markdown, chunk and index |
| `ctx_stats` | Show context savings and session metrics |
| `ctx_doctor` | Runtime diagnostics |
| `ctx_upgrade` | Update context-mode to the latest version |

---

## Session continuity

The extension tracks five event types in SQLite:

| Event | Captured from |
|-------|--------------|
| `file_modified` | `Edit`, `Write`, `MultiEdit` tool results |
| `git_operation` | `git commit/push/pull/merge` in Bash results |
| `error` | Error patterns in Bash output |
| `task` | `TodoWrite` tool calls |
| `decision` | User prompts containing corrections/decisions |
| `user_prompt` | All non-system user messages |

Before compaction, a `<2 KB XML snapshot` is saved. When the session resumes, the snapshot is injected automatically so the model continues exactly where it left off.

---

## Configuration

No configuration is required. The extension auto-initialises on `session_start`.

To disable specific routing rules (e.g., allow direct `WebFetch`), you can fork `src/events/tool-call.ts` and remove the relevant handler.

---

## Development

```sh
npm install
npm run dev      # watch mode
npm run build    # one-time build
```

### Project layout

```
src/
├── index.ts              # Extension factory (OMP entry point)
├── types.ts              # OMP ExtensionAPI type stubs
├── routing.ts            # ROUTING_BLOCK, per-tool guidance, snapshot builder
├── mcp-server.ts         # Spawns context-mode MCP, registers ctx_* tools
├── session/
│   ├── db.ts             # SQLite session DB (schema-compatible with context-mode)
│   └── helpers.ts        # Path helpers, project hash, session ID derivation
└── events/
    ├── session-start.ts  # session_start → inject routing/snapshot (SessionStart)
    ├── tool-call.ts      # tool_call → routing/blocking (PreToolUse)
    ├── tool-result.ts    # tool_result → event capture (PostToolUse)
    ├── pre-compact.ts    # session_before_compact → snapshot (PreCompact)
    └── user-input.ts     # input → prompt capture (UserPromptSubmit)
```

---

## Licence

MIT — see [LICENSE](LICENSE).

context-mode is licensed under [Elastic-2.0](https://github.com/mksglu/context-mode/blob/main/LICENSE).
