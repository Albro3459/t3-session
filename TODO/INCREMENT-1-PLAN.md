# Increment 1 implementation plan

## Status

Implemented. This document covers Increment 1 from `TODO/ROADMAP.md`:

- listing threads;
- filtering and pagination;
- bounded thread retrieval;
- chronological normalized JSONL output;
- tests and Skill examples.

Live tailing and subagent hierarchy were not implemented and remain deferred to Increments 2 and 3.

The sections below are the original plan and are kept as written. Where the plan left a contract decision open, the resolution is recorded in "Decisions made during implementation".

## Decisions made during implementation

- **Partial-retrieval marker.** `selection` was added to `thread.v1` as an optional property and is omitted entirely for full retrieval, so unbounded `get` output is unchanged and existing consumers are unaffected. No new thread schema version was needed.
- **Null-timestamp rule.** Records and threads with a null ordering timestamp sort last, in both the default and reversed order, everywhere the rule applies: list ordering, turn-window selection, and normalized JSONL. Threads with a null `updated_at` are excluded entirely when `--since` or `--before` is used, because a null timestamp cannot satisfy a bound.
- **JSONL tie-breaking.** Primary key is the event timestamp compared as a string, since stored values are ISO-8601 UTC. Ties break by record type (turn, then message, then activity), then by a numeric secondary key (`rowId` for turns, `sequence` for activities), then by the type's stable identifier.
- **Project filter.** Exact case-insensitive match on the trimmed project title, not a substring search. `find --title` remains the substring search.
- **Limits.** `list` defaults to 50. `--turn-limit` defaults to 1 when only `--turn-offset` is supplied. No maximum cap was added, because full `get` is already unbounded and an artificial ceiling would have been inconsistent.
- **`find` ordering.** Changed from newest-first (`updated_at` descending) to oldest-first chronological with a deterministic `thread_id` tie-breaker, so `--reverse` means the same thing for `find` and `list`. The result shape is unchanged; `list` is the envelope-based paginated command. Recorded in the README as a pre-1.0 correction alongside the JSONL ordering change.
- **Validation.** All option validation lives in `src/query-options.js` and is shared by the CLI and the Node API, so a library caller cannot bypass it. Validation runs before SQLite is opened.
- **`list --format jsonl`.** Emits a `list` header record carrying the envelope metadata, followed by one `thread` record per summary. `"list"` was added to the `jsonl-record.v1` `recordType` enum as an additive change.

## Known limitation accepted for this increment

`retrieveThreadWindowRows` builds `IN (...)` clauses from the selected turn IDs, so a window of roughly ten thousand or more turns would exceed SQLite's variable limit and surface a `DATABASE_UNAVAILABLE` error rather than data. This was judged not worth a chunked-query fallback: `--turn-limit` defaults to 1 and the full retrieval path does not use this query.

## Objective

Make it easy for an agent or human to identify a likely T3 thread, inspect a bounded portion of it, and consume its records without filling the context window.

The primary workflows should be:

```bash
t3-session list --reverse --limit 20 --format json

t3-session list --project "CodeLaunch" --since 2026-08-10 --reverse --limit 20 --format json

t3-session get THREAD_ID --last-turn --format json

t3-session get THREAD_ID --turn-limit 3 --format jsonl
```

The implementation remains local, read-only, SQLite-first, and based on the existing projection tables.

## Existing implementation to preserve

Relevant current code:

- `src/cli.js` parses arguments and dispatches `get`, `find`, `doctor`, `schema`, and `install`.
- `src/index.js` exposes `createT3SessionClient()` and the public Node API.
- `src/sqlite-store.js` owns read-only SQLite access, required-schema validation, thread queries, and title search.
- `src/normalize.js` converts SQLite rows into `t3-session.thread.v1` objects.
- `src/output.js` formats human, JSON, and normalized JSONL output.
- `schemas/thread.v1.json` and `schemas/jsonl-record.v1.json` define current output contracts.
- `skills/t3-session/SKILL.md` and its references teach agents the current recovery workflow.
- Existing fixtures under `test/fixtures/` provide sanitized SQLite data and must remain read-only in production behavior.

Do not change the storage root resolution, provider raw JSONL behavior, installer behavior, or privacy guarantees unless the new feature requires a narrowly scoped compatibility change.

## CLI contract

### `list`

Add a new command:

```bash
t3-session list
```

Supported options:

```text
--project <text>       Match a project title, case-insensitively.
--since <timestamp>    Include threads with updated_at >= timestamp.
--before <timestamp>   Include threads with updated_at < timestamp.
--limit <integer>      Maximum number of returned threads.
--offset <integer>     Number of matching threads to skip.
--reverse              Sort newest-first instead of oldest-first.
--format human|json|jsonl
```

Rules:

- Default sort column is `projection_threads.updated_at`.
- Default order is chronological, oldest to newest.
- `--reverse` changes the order to newest to oldest.
- Add a deterministic `thread_id` tie-breaker in the same direction.
- `--since` is inclusive; `--before` is exclusive so adjacent time windows compose cleanly.
- Accept ISO-8601 timestamps. Invalid timestamps must produce the existing machine-readable invalid-arguments error before opening SQLite.
- Trim project input and reject an empty project filter.
- Reject negative, non-integer, or otherwise invalid limit/offset values before opening SQLite.
- Use a conservative default limit, preferably 50, so an agent cannot accidentally retrieve an unbounded listing. Document the default and how to request a different limit.
- Use a bounded SQL query. Fetching `limit + 1` rows is acceptable for computing `hasMore` without a separate count query.
- Deleted threads remain excluded.
- Listing output contains metadata only; it must not include full message or activity text.

The project filter should initially match `projection_projects.title` case-insensitively. Keep the query parameterized. Supporting project IDs can be added only if it does not make the first implementation ambiguous; project title matching is the required behavior.

### Existing `find`

Keep `find --title` as a focused title search. It should share the same deterministic chronological ordering and pagination primitives where practical, without breaking its existing result shape unexpectedly.

At minimum:

- add `--reverse` support to `find`;
- preserve literal `%`, `_`, backslash, and quote handling;
- preserve exclusion of deleted threads;
- preserve the existing normalized search-result objects;
- add tests for ordering and any newly supported bounds.

If changing `find` output shape would break the current contract, leave its output shape unchanged and document that `list` is the envelope-based paginated command.

### Bounded `get`

Add options that prevent full-history retrieval when only a recent check is needed:

```text
--last-turn            Retrieve the newest turn and its associated records.
--turn <turn-id>       Retrieve one exact turn and its associated records.
--turn-limit <n>       Retrieve a bounded window of turns from the newest side.
--turn-offset <n>      Skip turns from the newest side before applying --turn-limit.
```

Rules:

- `--last-turn` is shorthand for a one-turn newest-side window.
- `--turn` is mutually exclusive with `--last-turn`, `--turn-limit`, and `--turn-offset`.
- `--turn-offset` and `--turn-limit` are mutually usable; they operate on turns ordered newest-first for selection.
- The selected turns and their records are emitted in chronological order, regardless of newest-side selection.
- `--turn-limit` must be bounded and validated as a non-negative integer. Define and test the default when it is omitted.
- The full thread metadata and provider metadata remain available, but `turns`, `messages`, and `activities` contain only the selected window.
- The existing unbounded `get THREAD_ID` behavior remains unchanged.
- An empty valid window returns a valid normalized thread with empty selected arrays, not a missing-thread error.

Association rules are important because projected user messages may have `turn_id = NULL`. For each selected turn, include:

- the turn row;
- activities whose `turn_id` matches the turn;
- the message identified by `pending_message_id`, when present;
- the message identified by `assistant_message_id`, when present;
- any other messages whose `turn_id` matches the turn.

Deduplicate by message ID when an association appears through more than one path. Add fixture coverage for user messages with null `turn_id` so `--last-turn` includes the user prompt that initiated the turn.

## Normalized output and ordering

### JSON object output

Keep `t3-session.thread.v1` as the complete normalized object contract. For bounded retrieval, document that the selected arrays are intentionally partial and add an explicit bounded-selection field only if it can be added compatibly, for example:

```json
{
  "selection": {
    "kind": "turn-window",
    "turnLimit": 1,
    "turnOffset": 0,
    "selectedTurnIds": ["..."]
  }
}
```

If a new required field would make the current schema incompatible, create a versioned schema rather than silently changing the meaning of `thread.v1`. The implementation must make partial retrieval distinguishable to machine consumers.

### Normalized JSONL output

The default normalized JSONL output must be chronological rather than grouped as all turns, then all messages, then all activities.

Keep the existing record envelope:

```json
{
  "schemaVersion": "t3-session.jsonl-record.v1",
  "recordType": "message",
  "threadId": "THREAD_ID",
  "data": {}
}
```

Ordering requirements:

1. Emit the thread metadata record first as the stream header.
2. Emit selected turn, message, and activity records in chronological order after the header.
3. Use each record's event timestamp as the primary key.
4. Use stable type-specific identifiers and turn/row ordering as deterministic tie-breakers.
5. Preserve all selected records, including records with null timestamps; place null-timestamp records deterministically and document the rule.
6. Keep provider and warnings on the thread header as today, unless a schema change is required.

Because the package is still pre-1.0, correcting the current grouped ordering is acceptable if the existing tests and schema documentation are updated. Do not call the output `ndjson`; use `jsonl` consistently.

Human output may remain sectioned and readable, but its bounded retrieval sections must clearly indicate that the output is partial.

## Node API

Expose the same operations through `createT3SessionClient()`:

```js
await client.listThreads({
  project,
  since,
  before,
  limit,
  offset,
  reverse,
});

await client.getThread(threadId, {
  lastTurn: true,
});

await client.getThread(threadId, {
  turnLimit: 3,
  turnOffset: 0,
});

await client.getThread(threadId, {
  turnId,
});
```

Use names that match the existing `findThreads()` and `getThread()` style. If the implementation chooses `listThreads()` versus `list()`, document and export one stable public name; do not expose CLI-only behavior.

Validate public API options in the library layer as well as CLI parsing so callers cannot bypass validation.

## Data access design

Add a parameterized list query in `src/sqlite-store.js` that joins `projection_threads` to `projection_projects` and returns metadata rows only.

The query must:

- use `deleted_at IS NULL`;
- use `COLLATE NOCASE` for project title filtering;
- use parameterized timestamp, limit, and offset values;
- use deterministic ascending/descending ordering;
- preserve read-only transactions and required schema validation;
- avoid interpolating user-provided values into SQL.

Add focused retrieval helpers for selected turns rather than loading the entire thread and filtering only after normalization. This keeps bounded retrieval useful for large threads and avoids unnecessary context/memory use.

The existing full retrieval path must continue to return all records in its current normalized arrays.

## Output schemas

Add a versioned list schema, preferably `schemas/list.v1.json`, covering:

- `schemaVersion`;
- `toolVersion`;
- filter and ordering metadata;
- returned thread summaries;
- `limit`, `offset`, returned count, and `hasMore`.

Register it in `src/schema.js` so this works:

```bash
t3-session schema list.v1
```

Update `jsonl-record.v1` only as needed to document chronological ordering. If the bounded thread metadata requires a breaking change, add a separate versioned schema and make the compatibility decision explicit in the implementation notes.

## Tests required before review

Tests are part of the implementation, not follow-up work. Add or update tests for all of the following:

### SQLite and API tests

- list returns project/title/date metadata without message content;
- default chronological ordering is oldest-first;
- `reverse` returns newest-first;
- equal timestamps use deterministic thread-ID ordering;
- project matching is case-insensitive and trimmed;
- `since` is inclusive;
- `before` is exclusive;
- adjacent since/before windows do not overlap;
- deleted threads are excluded;
- limit and offset produce correct pages;
- `hasMore` is correct at and beyond the final page;
- invalid dates, limits, offsets, and empty project values fail before database access;
- missing database and invalid schema preserve existing error behavior;
- full `getThread()` remains backward compatible;
- `last-turn` selects the newest turn;
- exact `turn` selection works;
- turn windows and offsets work;
- null-turn user messages linked through `pending_message_id` are included;
- selected records are deduplicated;
- empty valid selections are not treated as missing threads;
- production reads do not modify the SQLite database.

### Ordering tests

- normalized JSONL starts with the thread header;
- records after the header are chronological;
- timestamp ties are deterministic;
- null timestamps follow the documented rule;
- the JSONL schema still validates every emitted record;
- bounded output contains only selected records.

### CLI tests

- `list` parses options before and after the command;
- human, JSON, and JSONL list formats work;
- invalid combinations and values return the existing machine-readable error schema;
- `get --last-turn`, `--turn`, `--turn-limit`, and `--turn-offset` parse and dispatch correctly;
- mutually exclusive options are rejected;
- stdout remains clean for machine-readable formats and diagnostics remain on stderr;
- help text documents every Increment 1 option.

### Fixture and schema tests

- extend sanitized fixtures with multiple projects, multiple timestamps, deleted rows, pagination boundaries, and multiple turns;
- add a sanitized list schema fixture and validate its required fields;
- keep all tests isolated from the real T3 home and real user data.

## Skill and documentation work required before review

Update the bundled Skill, its references, and the README with examples for:

```bash
t3-session list --reverse --limit 20 --format json
t3-session list --project "CodeLaunch" --since 2026-08-10 --format json
t3-session get THREAD_ID --last-turn --format json
t3-session get THREAD_ID --turn-limit 3 --format jsonl
t3-session get THREAD_ID --format jsonl
```

The Skill must teach agents to:

1. list recent candidates before guessing a thread ID;
2. use project, since, before, limit, offset, and reverse deliberately;
3. use `--last-turn` to verify a candidate before retrieving the full history;
4. treat bounded output as partial history;
5. rely on chronological JSONL ordering;
6. preserve warnings and machine-readable diagnostics;
7. avoid broad storage discovery and avoid printing sensitive transcript content unnecessarily.

Add troubleshooting examples for an empty page, a missing project match, and an active or partially persisted thread without promising Increment 2 tailing behavior.

## Implementation sequencing

The main agent will split implementation into small, non-overlapping tasks and assign them to one to three Sonnet 5 medium subagents at a time. The main agent remains responsible for orchestration, reasoning, contract decisions, integration, and final review.

Suggested task boundaries:

1. SQLite/API listing queries, filters, ordering, and pagination.
2. Bounded turn retrieval and normalized chronological output.
3. CLI wiring, schemas, README, Skill examples, and test completion.

These boundaries may be adjusted after inspecting the implementation, but each subagent must receive exact instructions and an explicit file scope. Subagents must listen to the main agent's implementation instructions and must not create or launch their own subagents.

Do not begin review while implementation tasks are still running. First complete all code, tests, schemas, README changes, and Skill examples. Run the required syntax checks and test suite. Tests must pass before review begins.

After the increment is complete, the main agent may review directly and may ask fresh subagents for independent review. Use no more than three review loops for Increment 1. Each loop must end with fixes, tests, and a re-check before another loop begins.

## Definition of done

Increment 1 is complete only when:

- all listed CLI and Node API features are implemented;
- list ordering, filtering, pagination, and bounded retrieval are covered by tests;
- normalized JSONL is chronological by default;
- schemas and help output describe the new contracts;
- README and Skill examples are present and accurate;
- the implementation remains read-only and SQLite-first;
- syntax checks pass;
- the complete test suite passes;
- the main-agent review and any fresh-subagent review loops find no unresolved Increment 1 issues;
- no Increment 2 or Increment 3 code has been introduced.
