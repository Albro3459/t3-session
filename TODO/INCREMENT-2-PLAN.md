# Increment 2 implementation plan

## Status

Planned only. This document covers Increment 2 from `TODO/ROADMAP.md`:

- explicit completeness and live-state metadata on normalized thread output;
- a read-only `tail` command that polls the SQLite projection;
- explicit `upsert` operations for new and in-place-updated records;
- `--once`, polling interval, interruption, and partial-read behavior;
- WAL and live-update fixtures and tests;
- Skill examples for checking an active thread and following updates.

Do not implement subagent participants or hierarchy in this increment. That is Increment 3.

## Objective

Make it possible for an agent to answer two questions that Increment 1 cannot answer:

1. Is this thread settled, or is a turn still in progress right now?
2. What changed in this thread since I last looked?

The primary workflows should be:

```bash
t3-session get THREAD_ID --format json

t3-session tail THREAD_ID --once --format jsonl

t3-session tail THREAD_ID --interval 2000 --format jsonl

t3-session tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
```

The implementation remains local, read-only, SQLite-first, and based on the existing projection tables.

## Existing implementation to preserve

Increment 1 is complete and committed. Relevant current code:

- `src/cli.js` parses arguments and dispatches `list`, `get`, `find`, `doctor`, `schema`, and `install`.
- `src/index.js` exposes `createT3SessionClient()` with `listThreads()`, `getThread()`, `findThreads()`, `readRawJsonl()`, and `doctor()`.
- `src/query-options.js` owns all shared option validation and runs before SQLite is opened.
- `src/sqlite-store.js` owns read-only SQLite access, required-schema validation, list queries, bounded turn-window retrieval, and title search.
- `src/normalize.js` converts SQLite rows into `t3-session.thread.v1` and `t3-session.list.v1` objects.
- `src/output.js` formats human, JSON, and chronological JSONL output.
- `schemas/thread.v1.json`, `schemas/list.v1.json`, `schemas/jsonl-record.v1.json`, and `schemas/error.v1.json` define current output contracts.
- `skills/t3-session/SKILL.md` and its references teach agents the list, confirm, and retrieve workflow.

Do not change storage root resolution, provider raw JSONL behavior, installer behavior, list or bounded-retrieval semantics, or privacy guarantees unless the new feature requires a narrowly scoped compatibility change.

The Increment 1 null-timestamp rule must be preserved everywhere: records and threads with a null ordering timestamp sort last, in both directions.

## Live-state metadata

### Contract

Add a `liveState` object to normalized thread output. Unlike `selection`, which is present only for bounded reads, `liveState` is **always present** on `getThread()` output. An agent must not have to opt in to learn that the data it is reading may still be changing.

```json
{
  "liveState": {
    "status": "active",
    "complete": false,
    "observedAt": "2026-08-12T10:00:00.000Z",
    "providerStatus": "running",
    "latestTurnId": "turn-9",
    "latestTurnState": "streaming",
    "streamingMessageCount": 1,
    "reasons": ["turn-not-terminal", "streaming-message"]
  }
}
```

Field rules:

- `status` is `"active"`, `"idle"`, or `"unknown"`. Use `"unknown"` when the projection provides no usable signal, never as a default for a thread that is clearly settled.
- `complete` is `false` when the thread appears to still be changing, and `true` when it appears settled. It describes the thread, not the retrieval window. A bounded `get --last-turn` on a settled thread still reports `complete: true`; partialness of the window is already signalled by `selection`.
- `observedAt` is the tool's own read timestamp in ISO-8601 UTC. It is the only value in the package that is generated rather than projected, so it must be injectable for deterministic tests.
- `reasons` is a sorted array of stable machine-readable codes explaining why `complete` is `false`. Use a closed set: `"turn-not-terminal"`, `"streaming-message"`, `"provider-active"`. An empty array when `complete` is `true`.

Derive the signals from, in order:

1. `projection_thread_sessions.status` for the thread;
2. the state of the thread's latest turn, resolved through `projection_threads.latest_turn_id` and falling back to the newest turn by the Increment 1 turn ordering key when `latest_turn_id` is null or does not resolve;
3. the count of `projection_thread_messages` rows for the thread with `is_streaming` truthy.

Define the terminal turn states explicitly as a frozen exported constant rather than scattering string literals. Treat unrecognised turn states as non-terminal and record `"turn-not-terminal"`, because guessing that an unknown state is finished is the more damaging error.

Do not infer live state from timestamp recency. A thread is not active merely because it was updated recently.

### Compatibility

`schemas/thread.v1.json` uses `additionalProperties: false`, so add `liveState` as an optional property there, exactly as `selection` was added in Increment 1. Adding an always-present key means `get --format json` output is no longer byte-identical to 0.1.0. That is an accepted additive change for a pre-1.0 package; record it in the README compatibility section alongside the two Increment 1 corrections. Do not create a `thread.v2`.

`liveState` must be computed from a dedicated small query, not from whichever message rows a bounded window happened to select. A bounded `--last-turn` read must report the same `liveState` as a full read of the same thread at the same moment.

## CLI contract

### `tail`

Add a new command:

```bash
t3-session tail THREAD_ID
```

Supported options:

```text
--once                 Poll once, emit the result, and exit
--interval <ms>        Poll interval in milliseconds, default 1000
--max-cycles <n>       Stop after n poll cycles
--timeout <ms>         Stop after a wall-clock duration
--turn-limit <n>       Bound each poll to the newest n turns
--format jsonl|json    Output format, jsonl is the default
```

Rules:

- `tail` is read-only and polls the SQLite projection. It must not treat provider JSONL as the canonical transcript, and must not open the provider log at all.
- Each poll cycle opens a fresh read-only connection, reads inside a deferred transaction, rolls back, and closes, exactly as existing retrieval does. A long-lived open snapshot would never observe another process's WAL commits.
- `--interval` is validated as an integer in the range 100 to 60000 inclusive. Reject values outside it before opening SQLite. A tighter poll offers no benefit against a projection that updates per turn, and an unbounded one is a foot-gun.
- `--once` is mutually exclusive with `--interval`, `--max-cycles`, and `--timeout`.
- `--max-cycles` and `--timeout` are mutually usable; whichever triggers first stops the tail.
- With none of `--once`, `--max-cycles`, or `--timeout`, `tail` follows indefinitely until interrupted. This is the only unbounded loop in the package and must be interruptible.
- `--turn-limit` reuses the Increment 1 turn-window machinery and is validated by the existing `normalizeCount`. It bounds the cost of each poll on a large thread.
- `--format json` emits a single JSON array of the records produced by the whole run. It is only meaningful with `--once`, `--max-cycles`, or `--timeout`; reject it for an unbounded tail rather than buffering forever.
- Reject `--title`, `--raw-jsonl`, and every `list` filter option on `tail`, following the existing per-command rejection tables in `src/cli.js`.

`tail` is a storage command, so add it to both `COMMANDS` and `STORAGE_COMMANDS`.

### Existing commands

`list`, `get`, `find`, `doctor`, `schema`, and `install` keep their current behavior and output shapes, with the single exception of the additive `liveState` field on `get`. Add `--turn-limit`-style options to `tail` only; do not extend `list`.

## Tail record contract

Tail output is a new versioned record type. Do not overload `t3-session.jsonl-record.v1`, because tail records carry an operation and an observation timestamp that thread records do not.

```json
{
  "schemaVersion": "t3-session.tail-record.v1",
  "op": "upsert",
  "recordType": "message",
  "threadId": "THREAD_ID",
  "observedAt": "2026-08-12T10:00:00.000Z",
  "cycle": 1,
  "data": {}
}
```

Rules:

- `op` is `"upsert"`, `"live-state"`, or `"end"`.
- `recordType` is `"thread"`, `"turn"`, `"message"`, `"activity"`, `"live-state"`, or `"end"`.
- `cycle` is a 1-based poll cycle counter.
- The first cycle emits the current state as a baseline: a `thread` record, then every turn, message, and activity record, all with `op: "upsert"`. A record seen for the first time and a record whose content changed are both `upsert`; the consumer is expected to key on the record's stable identifier and replace. This satisfies the roadmap's requirement for an explicit in-place update operation without inventing a separate `insert`.
- Later cycles emit `upsert` records only for records that are new or whose content changed since the previous cycle.
- Records within a single cycle are emitted in the Increment 1 chronological order. Reuse that comparator; do not reimplement it.
- A `live-state` record is emitted in cycle 1 and thereafter only when `liveState` changes.
- Exactly one `end` record is emitted when the tail stops, carrying a `reason` in `data`: `"once"`, `"max-cycles"`, `"timeout"`, `"interrupt"`, or `"thread-not-found"`.
- Deletions are out of scope for this increment. A record that disappears from the projection is not reported. Document this limitation rather than guessing.

Change detection compares a stable serialization of the normalized record against the previous cycle's value, keyed by `turn:<turnId or rowId>`, `message:<messageId>`, and `activity:<activityId>`. `updated_at` alone is not a sufficient signal, because streaming text can change in place. Memory is bounded by thread size; note that in the implementation.

## Interruption and partial reads

These behaviors are the substance of the increment, not edge cases. Implement and test all of them.

- **SIGINT.** On interrupt, stop polling, emit the `end` record with reason `"interrupt"`, flush stdout, and exit 0. Do not leave a database handle open and do not emit a stack trace.
- **Broken pipe.** When stdout closes early, for example under `head`, exit quietly without an unhandled `EPIPE` error.
- **Transient database errors.** A busy or locked database during one cycle must not kill the tail. Retry on the next cycle, up to three consecutive failures, writing a machine-readable diagnostic to stderr each time. On the fourth consecutive failure, fail with the existing `DatabaseUnavailableError` and exit 4.
- **Thread disappears mid-tail.** If the thread is deleted or becomes unreadable while tailing, emit the `end` record with reason `"thread-not-found"` and exit 2, matching the existing `ThreadNotFoundError` exit code.
- **Missing thread at startup.** Behaves exactly as `get` does today: `ThreadNotFoundError`, exit 2, nothing on stdout.

Exit codes are unchanged; do not add new ones.

## Node API

Expose the same capability through `createT3SessionClient()` as an async iterator, which is cancellable and testable without spawning a process:

```js
const tail = client.tailThread(threadId, {
  intervalMs: 1000,
  once: false,
  maxCycles: 5,
  timeoutMs: 30000,
  turnLimit: 2,
  signal: abortController.signal,
});

for await (const record of tail) {
  // t3-session.tail-record.v1 objects
}
```

Requirements:

- Validate options in the library layer as well as in CLI parsing, so a library caller cannot bypass validation. Extend `src/query-options.js` rather than creating a second validation style.
- Support an `AbortSignal` for cancellation; the CLI wires SIGINT to it.
- Accept injectable `now()` and `sleep()` functions for deterministic tests. Default them to `Date.now`-based and timer-based implementations. Tests must not depend on real elapsed time.
- The iterator must always terminate by yielding exactly one `end` record, including when aborted.

## Data access design

Add to `src/sqlite-store.js`:

- a parameterized live-state query returning the provider status, the latest turn's identifier and state, and the streaming-message count in as few round trips as is reasonable;
- a reusable per-cycle read that returns the same row shape the existing full and windowed reads return, so normalization is shared.

The query must use `deleted_at IS NULL`, parameterized values, read-only transactions, required-schema validation, and no interpolation of user-provided values into SQL. The only literals that may be interpolated remain whitelisted `ASC`/`DESC` tokens and placeholder groups generated from an array length.

Do not add a new required table or column to `REQUIRED_TABLES` / `REQUIRED_COLUMNS` unless the live-state query genuinely cannot work without it. Adding a requirement would turn a previously healthy installation into a schema error.

## Output schemas

- Add `schemas/tail-record.v1.json` for `t3-session.tail-record.v1`, covering `schemaVersion`, `op`, `recordType`, `threadId`, `observedAt`, `cycle`, and `data`.
- Add the optional `liveState` property to `schemas/thread.v1.json`, with `status`, `complete`, `observedAt`, `providerStatus`, `latestTurnId`, `latestTurnState`, `streamingMessageCount`, and `reasons`.
- Register the new schema in `src/schema.js` so `t3-session schema tail-record.v1` works, and add it to `requiredReleaseFiles` and the version map in `test/package.test.js`.

## Tests required before review

Tests are part of the implementation, not follow-up work. Every timing-dependent test must use injected `now()`/`sleep()` or `--once`/`--max-cycles`. A test that sleeps against a real clock will be treated as a defect.

Put live-mutation fixtures in a **new** module, for example `test/fixtures/live-fixture.js`, exposing helpers to append a message, update a message in place, change a turn state, and set a session status. Do not change the row counts produced by `createFixtureDatabase()`; `test/sqlite-store.test.js` and `test/cli.test.js` both assert exact doctor counts and would break.

### Live-state tests

- a settled thread reports `complete: true`, `status: "idle"`, and empty `reasons`;
- a thread whose latest turn is non-terminal reports `complete: false` and `"turn-not-terminal"`;
- a thread with a streaming message reports `"streaming-message"`;
- an active provider session reports `"provider-active"`;
- multiple simultaneous signals produce a sorted, deduplicated `reasons` array;
- an unrecognised turn state is treated as non-terminal;
- `latest_turn_id` that is null or does not resolve falls back to the newest turn by the Increment 1 ordering key;
- a bounded `--last-turn` read reports the same `liveState` as a full read of the same thread;
- `observedAt` is injectable and deterministic;
- `liveState` is present on every `getThread()` result.

### Tail tests

- `--once` emits a baseline of every existing record plus a `live-state` record and exactly one `end` record with reason `"once"`;
- baseline records within a cycle are in chronological order;
- a message appended between cycles is emitted as a single `upsert` in the later cycle and is not re-emitted while unchanged;
- a message whose text changes in place between cycles is re-emitted as `upsert`, proving `updated_at` is not the only change signal;
- a turn state change between cycles is emitted;
- an unchanged cycle emits no data records;
- a `live-state` record is emitted in cycle 1 and again only when live state changes;
- `--max-cycles` stops with reason `"max-cycles"`;
- `--timeout` stops with reason `"timeout"` using an injected clock;
- aborting through an `AbortSignal` still yields exactly one `end` record;
- a thread deleted mid-tail ends with reason `"thread-not-found"` and exit code 2;
- three consecutive transient database failures are retried with stderr diagnostics and the fourth fails with exit code 4;
- `--turn-limit` bounds each cycle to the newest turns;
- every emitted record validates against `schemas/tail-record.v1.json`;
- tail never opens the provider log.

### WAL and read-only tests

- extend the existing WAL coverage: a writer process appends rows in WAL mode while a tail is polling, and the tail observes them on a later cycle;
- production reads do not modify the database: size and mtime are unchanged across a full tail run;
- a read-only connection still refuses writes while tailing.

### CLI tests

- `tail` parses options before and after the command;
- `--once` and `--format json` work together, and `--format json` is rejected for an unbounded tail;
- mutually exclusive and out-of-range options return the existing machine-readable error schema with exit code 3;
- `--interval` bounds are enforced;
- list-only options, `--title`, and `--raw-jsonl` are rejected on `tail`;
- stdout stays clean for machine-readable formats and diagnostics stay on stderr;
- help text documents every Increment 2 option.

## Skill and documentation work required before review

Update the bundled Skill, its references, and the README with these examples:

```bash
t3-session get THREAD_ID --format json
t3-session tail THREAD_ID --once --format jsonl
t3-session tail THREAD_ID --interval 2000 --format jsonl
t3-session tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
```

The Skill must teach agents to:

1. read `liveState.complete` before summarising a thread, and say plainly when a thread is still active;
2. prefer `get --last-turn` for a one-shot check and `tail --once` for a change-oriented check;
3. use a bounded tail (`--once`, `--max-cycles`, or `--timeout`) rather than an unbounded one inside an automated workflow;
4. treat `upsert` as replace-by-identifier, not append;
5. rely on the chronological ordering within a cycle;
6. report interruption, retry diagnostics, and partial reads honestly instead of presenting a partial tail as a complete transcript;
7. avoid provider JSONL for live state, since the projection is canonical.

Add troubleshooting for a thread that never becomes complete, a tail that emits nothing because the thread is idle, and a busy or locked database. Do not promise Increment 3 participant or hierarchy behavior.

Remember that `skills/t3-session/` files are copied by an allowlist in `src/skill-install.js`. Editing the three existing skill files needs no installer change; adding a new file does.

## Implementation sequencing

The main agent will split implementation into small, non-overlapping tasks and assign them to one to three Sonnet 5 medium subagents at a time. The main agent remains responsible for orchestration, reasoning, contract decisions, integration, and final review.

Before launching any subagent, the main agent should land the shared foundation itself, so that parallel agents code against fixed contracts. That means at minimum: the tail option validation in `src/query-options.js`, the extraction of the Increment 1 chronological comparator into a shared module so tail and `get` cannot drift, the live fixture module, and the `src/index.js` wiring that pins every function name and signature.

Suggested task boundaries:

1. Live-state SQLite queries and normalization.
2. The tail engine: polling, change detection, record emission, cancellation, and retry.
3. CLI wiring, schemas, README, Skill examples, and test completion.

Each subagent must receive exact instructions and an explicit, disjoint file scope, and must not create or launch its own subagents.

Do not begin review while implementation tasks are still running. First complete all code, tests, schemas, README changes, and Skill examples. Run the required syntax checks and the full test suite. Tests must pass before review begins.

After the increment is complete, the main agent may review directly and may ask fresh subagents for independent review. Use no more than three review loops. Each loop must end with fixes, tests, and a re-check before another loop begins.

## Definition of done

Increment 2 is complete only when:

- `liveState` is present on all normalized thread output and is derived from projected signals, not from timestamp recency;
- `tail` polls the SQLite projection read-only and emits versioned `upsert`, `live-state`, and `end` records;
- interruption, broken pipes, transient database errors, and mid-tail thread loss all behave as specified;
- the Node API exposes a cancellable async iterator with injectable time;
- schemas and help output describe the new contracts;
- README and Skill examples are present and accurate;
- the implementation remains read-only and SQLite-first, and never treats provider JSONL as the live source;
- no test depends on real elapsed time;
- syntax checks pass and the complete test suite passes;
- the main-agent review and any fresh-subagent review loops find no unresolved Increment 2 issues;
- no Increment 3 code has been introduced.
