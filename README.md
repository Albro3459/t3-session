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

const tail = client.tailThread("THREAD_ID", { maxCycles: 5, turnLimit: 2 });
for await (const record of tail) { /* t3-session.tail-record.v1 */ }
```

`tailThread` accepts an `AbortSignal` (`signal`) for cancellation, and injectable `now()`/`sleep()` functions so tests can drive the tail deterministically without depending on real elapsed time.

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

### Live state

Unlike `selection`, which appears only for bounded reads, `liveState` is always present on `getThread()` output — an agent never has to opt in to learn that a thread may still be changing. Fields:

```text
status                  "active", "idle", or "unknown"; "unknown" means the projection gave no usable signal, not that the thread is settled
complete                false while the thread still appears to be changing, true once it appears settled
observedAt              the tool's own read timestamp, ISO-8601 UTC
providerStatus          the thread's provider session status, or null
latestTurnId            the latest turn's identifier, or null
latestTurnState         the latest turn's state, or null
streamingMessageCount   count of messages currently marked streaming
reasons                 sorted array of codes explaining why complete is false
```

`reasons` is drawn from a closed set: `"turn-not-terminal"`, `"streaming-message"`, `"provider-active"`. It is empty exactly when `complete` is `true`. `liveState` describes the thread, not the retrieval window: a bounded `--last-turn` read reports the same `liveState` as a full read of the same thread at the same moment. It is derived from projected signals only — the latest turn's state, streaming message rows, and the provider session status — never from timestamp recency. A thread is not considered active merely because it was updated recently.

## Follow a live thread

```bash
t3-session get THREAD_ID --format json
t3-session tail THREAD_ID --once --format jsonl
t3-session tail THREAD_ID --interval 2000 --format jsonl
t3-session tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
```

`tail` polls the SQLite projection read-only and reports what changed since the previous poll. It never opens the provider JSONL log; the projection is the only live source. Each poll cycle opens a fresh read-only connection, so a long-lived snapshot never hides another process's WAL commits.

Supported options:

```text
--once                 Poll once, emit the result, and exit
--interval <ms>        Poll interval in milliseconds; default 1000; integer from 100 to 60000 inclusive
--max-cycles <n>       Stop after n poll cycles
--timeout <ms>         Stop after a wall-clock duration, in milliseconds
--turn-limit <n>       Bound each poll to the newest n turns, reusing the get --turn-limit machinery
--format jsonl|json    Output format; jsonl is the default
```

`--once` is mutually exclusive with `--interval`, `--max-cycles`, and `--timeout`. `--max-cycles` and `--timeout` are mutually usable together; whichever fires first stops the tail. With none of `--once`, `--max-cycles`, or `--timeout` given, the tail follows indefinitely until interrupted — this is the only unbounded loop in the package. `--format json` buffers the whole run into a single JSON array of records, so it requires a bounded tail (`--once`, `--max-cycles`, or `--timeout`); an unbounded tail with `--format json` is rejected because it would never finish.

Each line (or array element, for `--format json`) is a `t3-session.tail-record.v1` record:

```text
schemaVersion   "t3-session.tail-record.v1"
op              "upsert", "live-state", or "end"
recordType      "thread", "turn", "message", "activity", "live-state", or "end"
threadId        the tailed thread's ID
observedAt      the tool's own read timestamp for the cycle, ISO-8601 UTC
cycle           1-based poll cycle counter
data            the record payload
```

`upsert` means replace-by-identifier, not append: a record seen for the first time and a record whose content changed both arrive as `upsert`, so a consumer keys on the record's stable identifier and replaces rather than accumulating a log. Cycle 1 always emits the full baseline — a `thread` record, then every existing turn, message, and activity record — and later cycles emit `upsert` records only for what is new or changed. Records within a single cycle are in the same chronological order as normalized JSONL. A `live-state` record is emitted in cycle 1 and thereafter only when `liveState` changes. Exactly one `end` record is emitted when the tail stops, carrying a `reason` of `"once"`, `"max-cycles"`, `"timeout"`, `"interrupt"`, or `"thread-not-found"`.

Known limitation: deletions are out of scope for this increment. A record that disappears from the projection is not reported.

Interruption and failure behavior:

- **SIGINT** stops polling, emits the `end` record with reason `"interrupt"`, and exits 0.
- **A closed stdout**, for example under `head`, is handled quietly — no unhandled `EPIPE` error.
- **A busy or locked database** during a cycle is retried on the next cycle rather than killing the tail, up to three consecutive failures, with a machine-readable diagnostic written to stderr each time. The fourth consecutive failure exits 4, the same code as other database-unavailable errors.
- **A thread that disappears mid-tail** emits the `end` record with reason `"thread-not-found"` and exits 2, the same code `get` uses for a missing thread.
- **A missing thread at startup** behaves exactly like `get`: exit 2, nothing on stdout.

Exit codes are unchanged from Increment 1.

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
t3-session schema tail-record.v1
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

`t3-session.list.v1` is a new schema for the paginated `list` command; it does not replace or version `thread.v1`. `selection` is an additive optional field on `thread.v1` — it is present only for bounded `get` retrieval, so existing consumers that read full threads are unaffected. `t3-session.tail-record.v1` is a new schema for the `tail` command; it does not version or replace `t3-session.jsonl-record.v1`, because tail records carry an operation and an observation timestamp that thread JSONL records do not.

The package is still pre-1.0, so three corrections are recorded here explicitly:

- Normalized JSONL (`get --format jsonl`) changed from grouped order (all turns, then all messages, then all activities) to chronological order by event timestamp.
- `find`'s default order changed from newest-first (`updated_at` descending) to oldest-first chronological, matching `list`; use `--reverse` to restore newest-first. Ties now break deterministically on `thread_id`.
- `liveState` is a new always-present property on `thread.v1`, which means `get --format json` output is no longer byte-identical to 0.1.0 output. This is an accepted additive change for a pre-1.0 package and does not create a `thread.v2`.

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
