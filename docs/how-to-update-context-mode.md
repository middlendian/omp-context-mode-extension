# How to update the context-mode dependency

This document is written for an AI agent (or a developer acting as one).
Follow every step in order. Do not skip the verification steps.

---

## Background

`context-mode` is an MCP server binary — it is **not** an importable library.
We pin it to an exact version in `src/mcp-server.ts` (`CONTEXT_MODE_VERSION`)
and spawn it via `npx context-mode@<version>` so that the session DB schema
stays in sync with our `SessionDB` wrapper (`src/session/db.ts`).

The schema is **not exported** from the npm package. Any mismatch silently
corrupts session continuity: events written by our hooks will land in the wrong
columns or be dropped entirely, breaking post-compaction context recovery.

---

## Step 1 — Determine the target version

```bash
npm show context-mode version          # latest stable
npm show context-mode versions --json  # full history
```

Note the current pinned version:

```bash
grep CONTEXT_MODE_VERSION src/mcp-server.ts
```

Identify the **changelog** for every version between current pin and target.
The changelog is at: https://github.com/mksglu/context-mode/releases

Look specifically for:
- Any mention of **database**, **schema**, **store**, **migration**, or **SQLite**
- Changes to **tool names** (ctx_execute, ctx_search, ctx_stats, etc.)
- Changes to **environment variables** (CLAUDE_PROJECT_DIR, etc.)

---

## Step 2 — Check for schema changes

### 2a. Read store.ts from the target version

```bash
npx --yes context-mode@<TARGET_VERSION> --version   # confirm it runs
```

Then find the schema by inspecting what the target version creates on disk:

```bash
CLAUDE_PROJECT_DIR=/tmp/cm-schema-probe npx context-mode@<TARGET_VERSION> &
sleep 3 && kill %1
sqlite3 ~/.claude/context-mode/sessions/*.db ".schema"
```

Compare the output to the tables listed in `REQUIRED_COLUMNS` in
`src/session/db.ts`:

```typescript
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  sessions:   ["id", "projectDir", "createdAt", "compactCount", "cleanupFlag"],
  events:     ["id", "sessionId", "eventType", "data", "timestamp"],
  snapshots:  ["sessionId", "snapshotXml", "createdAt"],
  rule_files: ["sessionId", "filePath", "content", "capturedAt"],
};
```

### 2b. Check for new required columns

If the new version adds columns that context-mode **writes and expects to
exist**, you must add them to our `CREATE TABLE` DDL in `SessionDB.init()`
(`src/session/db.ts` around line 93).

If the new version **renames or removes** a column we use, update every
read/write site in `db.ts` and update `REQUIRED_COLUMNS`.

---

## Step 3 — Check for tool name changes

List the tools the target version exposes:

```bash
# Start the server, then call listTools via a quick MCP client probe
CLAUDE_PROJECT_DIR=/tmp/cm-tool-probe npx context-mode@<TARGET_VERSION>
```

Alternatively, read the source on GitHub for that tag:
`https://github.com/mksglu/context-mode/blob/<TAG>/src/tools/`

Compare the tool names against the tool routing in `src/events/tool-call.ts`
and `src/routing.ts`:

- `ctx_execute`, `ctx_batch_execute`, `ctx_execute_file`
- `ctx_index`, `ctx_search`
- `ctx_fetch_and_index`
- `ctx_stats`, `ctx_doctor`, `ctx_upgrade`

If any tool was renamed, update the routing block constant in `src/routing.ts`
and the relevant guidance strings.

---

## Step 4 — Apply the version bump

Edit `src/mcp-server.ts`:

```typescript
// Before
export const CONTEXT_MODE_VERSION = "1.0.X";

// After
export const CONTEXT_MODE_VERSION = "1.0.Y";  // the new version
```

If schema columns changed, also update `src/session/db.ts`:
- `REQUIRED_COLUMNS` (the compatibility guard)
- `SessionDB.init()` DDL (the `CREATE TABLE IF NOT EXISTS` blocks)
- Any read/write methods that reference the changed column names

---

## Step 5 — Run the full test suite

```bash
npm test
```

All tests must pass. Pay particular attention to:

- `tests/unit/session-db.test.ts` — schema snapshot tests assert every
  required column is present in a freshly initialised `:memory:` DB
- `tests/unit/session-db.test.ts` — `verifySchemaCompat` tests exercise the
  live schema probe against databases with missing columns/tables
- `tests/integration/hooks.test.ts` — end-to-end lifecycle smoke test

If any schema snapshot test fails, it means `REQUIRED_COLUMNS` or the DDL in
`SessionDB.init()` is out of sync with each other. Fix those first.

---

## Step 6 — Smoke-test a live OMP session

This cannot be automated — it requires a real OMP agent session.

1. Start OMP in a test project directory.
2. Confirm `[context-mode] registered N MCP tools` appears in the logs with
   the expected tool names (N should be 7–9).
3. Confirm **no** `schema drift` warnings appear in the logs.
4. Run a few tool calls that produce output (e.g. list files, read a file).
5. Let the session run until OMP triggers auto-compaction (or trigger it
   manually with `/compact`).
6. Verify the session resumes with the correct snapshot context injected
   (you should see the `<session-directive>` block appear in the next turn).
7. Run `ctx stats` and `ctx search recent` to confirm the MCP tools respond.

---

## Step 7 — Commit

```bash
git add src/mcp-server.ts src/session/db.ts   # (and any other changed files)
git commit -m "chore: update context-mode pin to <VERSION>

- Bumped CONTEXT_MODE_VERSION from X to Y
- [List any schema / tool changes here, or 'No schema changes']
- All tests pass; smoke-tested live session compaction"
```

---

## What NOT to do

- **Do not** use `"latest"` or a semver range (`^`, `~`) in the `npx` call.
  context-mode does not publish breaking change notices reliably enough to
  trust loose pinning.
- **Do not** bump the version without running the schema probe in Step 2.
  A silent column rename will cause compaction snapshots to write to `null`
  columns and lose session context with no error logged.
- **Do not** skip the live smoke test. The `verifySchemaCompat` unit tests
  use synthetic databases; only a live session exercises the full spawn +
  connect + write + read loop.
