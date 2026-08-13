# t3-session CLI Reference

Assume the package is installed and the current task provides a sanitized thread ID.

## Configuration

```bash
t3-session --home <t3-home> get <thread-id>
T3_HOME=<t3-home> t3-session get <thread-id>
t3-session --db <state-db> get <thread-id>
```

Resolution order is `--home`, `T3_HOME`, then the default T3 home. `--db` overrides the derived SQLite path and is useful for isolated fixtures.

## List threads

```bash
t3-session list
t3-session list --project <text> --since <timestamp> --before <timestamp>
t3-session list --limit <n> --offset <n> --reverse
t3-session list --format human|json|jsonl
```

Options:

- `--project <text>` — match `projection_projects.title` case-insensitively; exact match on the trimmed title, not a substring search. Trimmed and rejected as invalid if empty.
- `--since <timestamp>` — inclusive lower bound on `updated_at`, ISO-8601.
- `--before <timestamp>` — exclusive upper bound on `updated_at`, ISO-8601. Adjacent `--since`/`--before` windows compose without overlap or double counting.
- `--limit <n>` — maximum threads returned; default 50; non-negative integer.
- `--offset <n>` — skip matching threads before applying `--limit`; default 0; non-negative integer.
- `--reverse` — newest-first instead of the default oldest-first.

Invalid timestamps, limits, offsets, or an empty project filter produce the existing machine-readable `t3-session.error.v1` error before SQLite is opened.

Ordering: sorted by `updated_at`, then by `thread_id` as a tie-breaker, in the same direction as `--reverse`. Threads with a null `updated_at` sort last in both directions and are excluded entirely when `--since` or `--before` is used, because a null timestamp cannot satisfy a bound. Deleted threads (`deleted_at IS NOT NULL`) are always excluded.

Output: `--format json` and `--format jsonl` emit the `t3-session.list.v1` envelope — `schemaVersion`, `toolVersion`, `filters` (`project`, `since`, `before`), `ordering` (`sortBy: "updatedAt"`, `direction`), `limit`, `offset`, `count`, `hasMore`, and `threads` (metadata-only summaries: `id`, `projectId`, `title`, `project`, `branch`, `worktreePath`, `createdAt`, `updatedAt`, `latestUserMessageAt`, `latestTurnId`). Listing output never contains message or activity text. `hasMore` indicates whether another page is available past `offset + limit`; page forward by increasing `--offset`.

## Retrieve a thread

```bash
t3-session get <thread-id>
t3-session get <thread-id> --format json
t3-session get <thread-id> --format jsonl
t3-session get <thread-id> --raw-jsonl
t3-session get <thread-id> --last-turn
t3-session get <thread-id> --turn <turn-id>
t3-session get <thread-id> --turn-limit <n> --turn-offset <n>
```

The default format shows thread metadata, provider metadata, turns, messages, activities, and warnings. JSON emits the complete `t3-session.thread.v1` object. Normalized JSONL emits `thread`, `turn`, `message`, and `activity` records using `t3-session.jsonl-record.v1`, in chronological order after the thread header — this is the default and only order for `get --format jsonl`; do not re-sort records.

`--raw-jsonl` emits parsed provider records one per line. A malformed provider line is reported on stderr and does not discard valid records.

### Bounded retrieval

- `--last-turn` — the newest turn and its associated records; shorthand for a one-turn newest-side window.
- `--turn <turn-id>` — one exact turn and its associated records.
- `--turn-limit <n>` — a bounded window of turns counted from the newest side; non-negative integer; defaults to 1 when only `--turn-offset` is given.
- `--turn-offset <n>` — skip turns from the newest side before applying `--turn-limit`; non-negative integer; default 0.

Mutually exclusive combinations, rejected with the machine-readable invalid-arguments error:

- `--turn` cannot be combined with `--last-turn`, `--turn-limit`, or `--turn-offset`.
- `--last-turn` cannot be combined with `--turn-limit` or `--turn-offset`.

Selection: turns are selected from the newest side, then always emitted in chronological order. For each selected turn, the window includes the turn row, activities whose `turn_id` matches, and messages reached through `pending_message_id`, `assistant_message_id`, or a matching `turn_id`. Projected user prompts are stored with a null `turn_id`, so they are only reachable through `pending_message_id` — this is why `--last-turn` still includes the user prompt that started the turn. Records reached through more than one association path are deduplicated by ID. An offset past the end, or a `--turn` ID that matches nothing, is a valid empty window: it returns a normalized thread with empty `turns`, `messages`, and `activities`, not a missing-thread error. Plain `get <thread-id>` with none of these options is unchanged and returns the full history.

Bounded output carries a `selection` object on the normalized thread: `kind` (`"turn"` or `"turn-window"`), `turnId`, `turnLimit`, `turnOffset`, `totalTurns`, `selectedTurnIds`. Full retrieval omits `selection` entirely — its presence is the machine-readable signal that output is partial. Human output for a bounded read adds a `Selection` block with `Partial history: yes` and renames the sections `Turns (partial)`, `Messages (partial)`, `Activities (partial)`.

### Live state

`liveState` is always present on `getThread()` output, unlike `selection`, which appears only for bounded reads:

- `status` — `"active"`, `"idle"`, or `"unknown"`; `"unknown"` means the projection gave no usable signal, not a default for a settled thread.
- `complete` — `false` while the thread still appears to be changing, `true` once settled. Describes the thread, not the retrieval window: a bounded `--last-turn` read reports the same `liveState` as a full read of the same thread at the same moment.
- `observedAt` — the tool's own read timestamp, ISO-8601 UTC.
- `providerStatus` — the thread's provider session status, or `null`.
- `latestTurnId` — the latest turn's identifier, or `null`.
- `latestTurnState` — the latest turn's state, or `null`.
- `streamingMessageCount` — count of messages currently marked streaming.
- `reasons` — sorted, deduplicated codes from the closed set `"turn-not-terminal"`, `"streaming-message"`, `"provider-active"`, explaining why `complete` is `false`; empty when `complete` is `true`.

`liveState` is derived from projected signals only — the latest turn's state, streaming message rows, and the provider session status — never from timestamp recency.

## Follow a live thread

```bash
t3-session tail <thread-id>
t3-session tail <thread-id> --once --format jsonl
t3-session tail <thread-id> --interval <ms> --format jsonl
t3-session tail <thread-id> --max-cycles <n> --timeout <ms> --turn-limit <n> --format jsonl
```

`tail` is read-only and polls the SQLite projection. It never opens the provider JSONL log. Each poll cycle opens a fresh read-only connection, reads inside a deferred transaction, rolls back, and closes — the same pattern as `get` — so a long-lived snapshot never hides another process's WAL commits.

Options:

- `--once` — poll once, emit the result, and exit. Mutually exclusive with `--interval`, `--max-cycles`, and `--timeout`.
- `--interval <ms>` — poll interval in milliseconds; default 1000; validated as an integer from 100 to 60000 inclusive, rejected outside that range before SQLite is opened.
- `--max-cycles <n>` — stop after `n` poll cycles. Usable together with `--timeout`; whichever fires first stops the tail.
- `--timeout <ms>` — stop after a wall-clock duration in milliseconds. Usable together with `--max-cycles`.
- `--turn-limit <n>` — bound each poll cycle to the newest `n` turns; reuses the same `normalizeCount`-validated window machinery as `get --turn-limit`.
- `--format jsonl|json` — `jsonl` is the default, one record per line. `json` buffers the whole run into a single JSON array and is only accepted with a bounded tail (`--once`, `--max-cycles`, or `--timeout`); an unbounded tail with `--format json` is rejected because it would never finish.

With none of `--once`, `--max-cycles`, or `--timeout` given, `tail` follows indefinitely until interrupted — the only unbounded loop in the package. `tail` rejects `--title`, `--raw-jsonl`, and every `list`-only filter option, following the same per-command rejection rules as other commands.

### Tail record contract

Each emitted record is `t3-session.tail-record.v1`:

```text
schemaVersion   "t3-session.tail-record.v1"
op              "upsert", "live-state", or "end"
recordType      "thread", "turn", "message", "activity", "live-state", or "end"
threadId        the tailed thread's ID (nullable)
observedAt      the tool's own read timestamp for the cycle, ISO-8601 UTC
cycle           1-based poll cycle counter (0 only on an end record emitted before any cycle ran)
data            the record payload
```

`upsert` is replace-by-identifier, not append: a record seen for the first time and a record whose content changed both arrive as `upsert`. Consumers key on the record's stable identifier (turn, message, or activity ID) and replace. Cycle 1 emits the full baseline — a `thread` record, then every turn, message, and activity record, all `upsert` — and later cycles emit `upsert` only for records that are new or changed. Records within a cycle are in the same chronological order as normalized JSONL; do not re-sort them. A `live-state` record is emitted in cycle 1 and thereafter only when `liveState` changes. Exactly one `end` record is emitted when the tail stops, with `data.reason` one of:

- `"once"` — `--once` completed its single poll.
- `"max-cycles"` — `--max-cycles` was reached.
- `"timeout"` — `--timeout` elapsed.
- `"interrupt"` — SIGINT (or an aborted `AbortSignal` in the Node API) stopped the tail.
- `"thread-not-found"` — the thread disappeared or became unreadable mid-tail.

Deletions are out of scope for this increment: a record that disappears from the projection is not reported.

### Interruption, retries, and exit codes

- **SIGINT** stops polling, emits the `end` record with reason `"interrupt"`, flushes stdout, and exits 0.
- **A closed stdout**, for example under `head`, is handled quietly — no unhandled `EPIPE` error.
- **A busy or locked database** during a cycle does not kill the tail; it is retried on the next cycle, up to three consecutive failures, with a machine-readable diagnostic written to stderr each time. The fourth consecutive failure raises the existing `DatabaseUnavailableError` and exits 4.
- **A thread that disappears mid-tail** emits the `end` record with reason `"thread-not-found"` and exits 2, matching `ThreadNotFoundError`.
- **A missing thread at startup** behaves exactly like `get`: `ThreadNotFoundError`, exit 2, nothing on stdout.

Exit codes are unchanged from Increment 1.

## Thread participants

```bash
t3-session participants <thread-id>
t3-session participants <thread-id> --format json
t3-session participants <thread-id> --tree --format json
t3-session participants <thread-id> --turn <turn-id> --format jsonl
```

A participant is one `taskId` within one thread, folded from that thread's explicit `task.started`, `task.progress`, `task.completed`, and `task.updated` activities, in the same chronological activity order `get` uses. The fold is last-non-null-wins per scalar field: a later activity that omits a field does not erase a value an earlier activity set.

Options:

- `--tree` — emit a nested tree instead of a flat array. Supported with `--format json` and `--format human`; rejected with `--format jsonl`, because JSONL is a flat one-record-per-line contract and a nested tree cannot be expressed in it without inventing a second envelope. `--tree` on a thread with no explicit parentage returns every participant as a root — that is correct output, not an error.
- `--last-turn` — only participants whose activities touch the newest turn; shorthand for a one-turn newest-side window (`selection.kind: "turn-window"`, `turnLimit: 1`, `turnOffset: 0`), the same resolution `get --last-turn` uses. Shares `get`'s mutual-exclusivity rule: cannot be combined with `--turn`, `--turn-limit`, or `--turn-offset`.
- `--turn <turn-id>` — only participants whose activities touch that turn.
- `--turn-limit <n>` — only participants touching the newest `n` turns.
- `--turn-offset <n>` — skip turns from the newest side before applying `--turn-limit`.
- `--limit <n>` — maximum participants returned; **no default**, so the full participant list is returned unless a smaller page is explicitly requested.
- `--offset <n>` — skip matching participants before applying `--limit`; default 0.
- `--reverse` — newest-first instead of the default oldest-first.
- `--format human|json|jsonl`.

`--last-turn`, `--turn`, `--turn-limit`, and `--turn-offset` reuse the same `normalizeTurnSelection` validation as `get`, and `--limit`/`--offset` reuse `normalizeCount`; all validation runs before SQLite is opened. `participants` rejects `--title`, `--raw-jsonl`, `--once`, `--interval`, `--max-cycles`, `--timeout`, and the `list`-only filters `--project`, `--since`, `--before`, following the same per-command rejection rules as other commands.

A `task.*` activity recorded with a null `turn_id` can never appear in any turn-bounded read (`--turn`, `--turn-limit`, `--turn-offset`, `--last-turn`): the underlying query matches selected turns with `turn_id IN (...)`, and SQL `NULL` never satisfies an `IN` list. This is deliberate and matches how `get` bounds its own turn windows on `turn_id`. It is a real, observed condition, not an edge case: roughly 98 of 6,338 observed `task.*` rows carry a null `turn_id`. A participant missing from a bounded view is not necessarily missing from the thread — re-run without turn selection to check the whole thread before concluding a participant is absent.

Ordering: sorted by `firstSeenAt`, then by `taskId` as a tie-breaker, in the same direction as `--reverse`. A participant with a null `firstSeenAt` sorts last in both directions, the same null-timestamp rule `list` and `find` use. Sibling labels inside `path` are always assigned in ascending order, so `--reverse` changes the display order without renumbering any path.

### Participant fields

Every participant carries `taskId`, `parentTaskId`, `path`, `depth`, `title`, `role`, `model`, `agentKind`, `taskType`, `effort`, `status`, `state`, `summary`, `detail`, `error`, `toolUseId`, `lastToolName`, `workflowName`, `outputFile`, `isBackgrounded`, `turnId`, `turnIds`, `firstSeenAt`, `lastSeenAt`, `activityCount`, and `usage`. Every field is always present; absent projection data is `null`, never a missing key. `usage` has `totalTokens`, `toolUses`, `durationMs`, normalized from whichever of `typedUsage` or the snake_case `usage` is present, preferring `typedUsage`; unknown values stay `null`, not `0`. Anything the projection carries that is not modeled above (`phases`, `runHandles`, `timelineBypass`, `usageSnapshot`, `attempt`, `agentIndex`, `phaseIndex`, `phaseTitle`, and similar) appears under `adapterSpecific`, never as a top-level field.

`state` versus `status`: `status` is the raw, projected value (or `null` if none was ever recorded). `state` is a derived summary — `"finished"` when `status` is one of the terminal values (`completed`, `failed`, `stopped`, `cancelled`), `"running"` when a non-terminal or unrecognised status was recorded, and `"unknown"` when no status was ever projected. An unrecognised status is deliberately reported as `"running"`, not `"finished"`, because claiming a still-running agent has finished is the more damaging error. `status: null` with `state: "unknown"` means the projection never recorded a status.

### Hierarchy

`parentTaskId` is populated **only** from an explicit `parentAgentId` recorded on a contributing activity, and only when it resolves to another participant's `taskId` in the same thread. Hierarchy is **never** inferred from timestamps, activity order, `sequence`, tool-use IDs, or identifier shape — two tasks that merely ran next to each other are two roots.

`hierarchyAvailable` is the machine-readable signal to check before presenting a tree: `true` only when at least one participant has a resolved `parentTaskId`. It is `false` for the great majority of real threads, and that is the correct, expected answer, not a failure.

`path` (for example `main.subagent1.subagent1a`) is present only when a participant's entire ancestry to a root is explicitly known and resolvable; it is `null` when any ancestor is unresolved or cyclic. The synthetic first segment is always `main`. Sibling segments are numbered by the deterministic participant ordering (`firstSeenAt`, then `taskId` as a tie-breaker) — that ordering only assigns a label to an already-known child; it is never used to infer the parent/child edge itself, which always comes from `parentAgentId`. `depth` is `0` for a root and `parent.depth + 1` otherwise, computed only through resolved edges.

A task whose `parentAgentId` equals its own `taskId` resolves — the identifier does name a known participant — so it is reported as `PARENT_CYCLE` (a one-node cycle), not `UNRESOLVED_PARENT`. A task that is merely downstream of a cycle, not on the cycle itself, keeps its own explicit `parentTaskId` and loses only its `path`, since ancestry through a broken link can no longer be confirmed; only tasks actually on the cycle are demoted to roots and named in `PARENT_CYCLE`.

Warning codes:

- `UNRESOLVED_PARENT` — a `parentAgentId` was recorded but does not resolve to a known participant. `parentTaskId` stays `null`, `path` stays `null`, and the participant is reported as a root.
- `PARENT_CYCLE` — recorded parentage forms a cycle (for example A's parent is B and B's parent is A, or a task naming itself as its own parent). The cycle members are reported as roots with `path: null` rather than hanging or overflowing.
- `PARENT_OUT_OF_PAGE` — `--tree` combined with `--limit`/`--offset`, where a resolved parent falls outside the returned page. The child is surfaced at the top level instead of being dropped, and the warning names the affected child task IDs. `counts` and `hierarchyAvailable` describe the whole thread, not the page, so `hierarchyAvailable: true` can legitimately accompany a visually flat or partial tree — check this warning, not just the tree's shape, before concluding hierarchy is missing.

### Envelope and exit codes

`--format json` and `--format jsonl` emit `t3-session.participants.v1`: `schemaVersion`, `toolVersion`, `threadId`, `ordering`, `selection` (`null` for a whole-thread read, otherwise the turn selection), `counts`, `hierarchyAvailable`, `participants`, and `warnings`. `--format jsonl` emits `t3-session.jsonl-record.v1` records: a `participants` header record carrying the envelope metadata, followed by one `participant` record per participant.

`counts` has two different scopes, and mixing them up is the easiest mistake a consumer can make: `counts.total` is the number of participants matching before `--limit`/`--offset` is applied, so truncation is detectable; `counts.participants` is how many were actually returned in this page. `counts.roots`, `counts.withExplicitParent`, `counts.unresolvedParents`, and `hierarchyAvailable` all describe the whole thread, not the page — they do not change when `--limit`/`--offset` shrinks what is returned.

- A thread that exists but has no task activities returns a valid envelope with an empty `participants` array, `counts.participants: 0`, and `hierarchyAvailable: false` — exit 0, not an error.
- A missing thread is `ThreadNotFoundError`, exit 2, nothing on stdout, exactly as `get`.
- Rejected or invalid options return the existing machine-readable `t3-session.error.v1` error, exit 3.

## Search and diagnose

```bash
t3-session find --title "topic"
t3-session find --title "topic" --format json
t3-session find --title "topic" --reverse
t3-session doctor
t3-session doctor --format json
```

Title search is trimmed, case-insensitive, parameterized, excludes deleted threads, and does not search message content. `find` defaults to oldest-first chronological order and takes `--reverse` for newest-first, the same meaning `--reverse` has for `list`. Its result shape is a bare array and is unchanged; `list` is the envelope-based, paginated command. Doctor reports the resolved home, database readability, schema health, counts, WAL presence, provider-log directory, runtime, and package version.

## Schemas

```bash
t3-session schema thread.v1
t3-session schema error.v1
t3-session schema jsonl-record.v1
t3-session schema list.v1
t3-session schema tail-record.v1
t3-session schema participants.v1
```

Schema output is written to stdout and is suitable for redirecting into a fixture or validator.

## Install the bundled skill

The package includes a sanitized recovery skill bundle. Install it for one agent target:

```bash
t3-session install --skills claude
t3-session install --skills codex
```

Destinations are `~/.claude/skills/t3-session` for Claude and `$CODEX_HOME/skills/t3-session`, or `~/.codex/skills/t3-session` when `CODEX_HOME` is unset.

An existing destination is never silently removed. Choose one explicit replacement policy:

```bash
t3-session install --skills claude --overwrite
t3-session install --skills claude --backup
t3-session install --skills codex --backup
```

`--overwrite` replaces the existing directory. `--backup` moves it to a timestamped sibling backup before installing. The installer copies only the package's allowlisted skill files and rejects a missing or malformed source bundle.
