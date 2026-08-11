# t3-session

`t3-session` is a small, read-only Node.js package and CLI for retrieving persisted T3 Code conversation threads by exact thread ID. It reads the documented SQLite projection and, on request, the exact provider JSONL event file. It does not scan arbitrary storage, call a cloud service, resume sessions, or write to T3 data.

## Requirements

- Node.js 22.16 or newer
- A local T3 home with the documented projection, when retrieving real data

## Installation

Install the public package globally:

```bash
npm install -g @albro3459/t3-session
```

Or run it without a global install:

```bash
npx @albro3459/t3-session --help
```

The package exposes the `t3-session` executable and a small ESM API. Verify the installed package version with:

```bash
t3-session --version
```

```js
import { createT3SessionClient } from "@albro3459/t3-session";

const client = await createT3SessionClient({ home: process.env.T3_HOME });
const thread = await client.getThread("THREAD_ID");
const recentTurn = await client.getThread("THREAD_ID", { lastTurn: true });
const matches = await client.findThreads({ title: "topic" });
const page = await client.listThreads({ project: "CodeLaunch", since: "2026-08-10", limit: 20 });
```

## Configuration

The normal SQLite path is resolved in this order:

1. `--home PATH`
2. `T3_HOME`
3. the default user T3 home

The derived database is `<home>/userdata/state.sqlite`. Use `--db PATH` for an isolated fixture or unusual installation. The exact provider file is `<home>/userdata/logs/provider/events.<thread-id>.log`.

## List threads

```bash
t3-session list
t3-session list --reverse --limit 20 --format json
t3-session list --project "CodeLaunch" --since 2026-08-10 --format json
```

Supported options:

```text
--project <text>       Match a project title, case-insensitively (exact match on the trimmed title, not a substring search)
--since <timestamp>    Inclusive lower bound on updated_at, ISO-8601
--before <timestamp>   Exclusive upper bound on updated_at, ISO-8601
--limit <n>            Maximum threads returned; default 50
--offset <n>           Skip matching threads before applying --limit
--reverse              Newest-first instead of the default oldest-first
--format human|json|jsonl
```

The default limit is 50, so a listing cannot be retrieved unbounded by accident; pass `--limit` to request a different page size. Ordering is deterministic: threads are sorted by `updated_at`, then by `thread_id` as a tie-breaker in the same direction. Threads with a null `updated_at` sort last in both the default and `--reverse` order, and are excluded entirely when `--since` or `--before` is used, since a null timestamp cannot satisfy a bound. `--since` is inclusive and `--before` is exclusive, so adjacent time windows compose without overlapping or double counting. Deleted threads are excluded. `--format json` and `--format jsonl` emit the `t3-session.list.v1` envelope, which reports `filters`, `ordering`, `limit`, `offset`, `count`, and `hasMore` alongside the returned `threads`. Use `hasMore` with `--offset` to page through results. Listing output contains thread metadata only — it never includes message or activity text.

## Retrieve a thread

```bash
t3-session get THREAD_ID
t3-session get THREAD_ID --format json
t3-session get THREAD_ID --format jsonl
t3-session get THREAD_ID --raw-jsonl
t3-session get THREAD_ID --last-turn --format json
t3-session get THREAD_ID --turn-limit 3 --format jsonl
```

The default output is human-readable metadata, provider information, turns, messages, activities, and warnings. `--format json` emits the complete `t3-session.thread.v1` object. `--format jsonl` emits stable normalized records with record types `thread`, `turn`, `message`, and `activity`, in chronological order after the thread header. `--raw-jsonl` emits parsed provider events and preserves their labels and timestamps. Malformed provider lines are reported as warnings without discarding valid records.

Bounded retrieval options limit `get` to a window of turns instead of the full history:

```text
--last-turn            The newest turn and its associated records (shorthand for a one-turn newest-side window)
--turn <turn-id>       One exact turn and its associated records
--turn-limit <n>       A bounded window of turns counted from the newest side (defaults to 1 when only --turn-offset is given)
--turn-offset <n>      Skip turns from the newest side before applying --turn-limit
```

`--turn` cannot be combined with `--last-turn`, `--turn-limit`, or `--turn-offset`; `--last-turn` cannot be combined with `--turn-limit` or `--turn-offset`. Turns are selected from the newest side but always emitted in chronological order. A window includes the turn row, the activities whose `turn_id` matches, and the messages reached through `pending_message_id`, `assistant_message_id`, or a matching `turn_id` — this includes projected user prompts, which are stored with a null `turn_id`, so `--last-turn` still includes the user prompt that started the turn. An offset past the end, or a `--turn` ID that matches nothing, returns a normalized thread with empty `turns`, `messages`, and `activities`, not a missing-thread error. Plain `t3-session get THREAD_ID` is unchanged and still returns the full history.

Bounded results are machine-detectable: the normalized thread gains a `selection` object (`kind`, `turnId`, `turnLimit`, `turnOffset`, `totalTurns`, `selectedTurnIds`). Full retrieval omits `selection` entirely, so existing consumers are unaffected. Human output for a bounded read shows a `Selection` block with `Partial history: yes` and labels the sections `Turns (partial)`, `Messages (partial)`, and `Activities (partial)`.

## Search and diagnose

Title search is trimmed, case-insensitive, parameterized, excludes deleted threads, and does not search message content:

```bash
t3-session find --title "topic"
t3-session find --title "topic" --format json
t3-session find --title "topic" --reverse
```

`find` defaults to oldest-first chronological order, matching `list`; pass `--reverse` for newest-first. Its result shape is unchanged — a bare array of search results. `list` is the envelope-based, paginated command; use it when you need `limit`, `offset`, `hasMore`, or filtering by project and time window.

Use doctor to inspect the expected installation without retrieving conversation content:

```bash
t3-session doctor
t3-session doctor --format json
```

Machine-readable data is written to stdout. Errors and raw JSONL partial-read diagnostics are written to stderr. The CLI uses stable exit codes and `t3-session.error.v1` errors.

## Bundled schemas

Print a schema for validation or integration work:

```bash
t3-session schema thread.v1
t3-session schema error.v1
t3-session schema jsonl-record.v1
t3-session schema list.v1
```

The bundled schemas are versioned and are included in the npm package.

## Claude and Codex skill installation

The package includes a recovery skill at `skills/t3-session/`. Install it for Claude or Codex:

```bash
t3-session install --skills claude
t3-session install --skills codex
```

The destinations mirror the `br0wser` convention:

- Claude: `~/.claude/skills/t3-session`
- Codex: `$CODEX_HOME/skills/t3-session`, or `~/.codex/skills/t3-session` when `CODEX_HOME` is unset

The installer validates the packaged source and copies only the allowlisted bundle files. It never silently removes an existing destination. If the destination already exists, choose an explicit policy:

```bash
t3-session install --skills claude --overwrite
t3-session install --skills claude --backup
t3-session install --skills codex --backup
```

`--overwrite` replaces only the resolved `t3-session` skill directory. `--backup` moves the existing directory to a timestamped sibling backup before installing. The installer rejects invalid targets and does not accept a user-controlled destination path.

## Privacy and read-only guarantees

The package opens SQLite read-only, allows SQLite WAL/SHM files to be used, and never writes projection data to T3 storage. SQLite may update existing WAL/SHM locking state while a read is active. It does not perform recursive discovery or broad filesystem searches. Use `--db` and temporary fixture homes for development and tests. Do not paste credentials, bearer tokens, private prompts, or unrelated local data into reports.

## Schema and compatibility policy

The normalized output is versioned as `t3-session.thread.v1`. JSONL records are versioned as `t3-session.jsonl-record.v1`, and machine-readable errors as `t3-session.error.v1`. New fields may be added without changing existing field meanings; a breaking output change requires a new schema version. The public API and CLI commands remain stable across compatible releases.

`t3-session.list.v1` is a new schema for the paginated `list` command; it does not replace or version `thread.v1`. `selection` is an additive optional field on `thread.v1` — it is present only for bounded `get` retrieval, so existing consumers that read full threads are unaffected.

The package is still pre-1.0, so two ordering corrections are recorded here explicitly:

- Normalized JSONL (`get --format jsonl`) changed from grouped order (all turns, then all messages, then all activities) to chronological order by event timestamp.
- `find`'s default order changed from newest-first (`updated_at` descending) to oldest-first chronological, matching `list`; use `--reverse` to restore newest-first. Ties now break deterministically on `thread_id`.

## Development

Run syntax validation and the built-in test suite:

```bash
npm run check
npm test
```

Tests use temporary fixture databases and sanitized provider records. They do not access a real user T3 home or real Claude/Codex skill directories. Review the release file list with:

```bash
npm pack --dry-run
```
