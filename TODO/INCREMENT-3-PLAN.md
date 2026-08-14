# Increment 3 implementation plan

## Status

Implemented. This document covers Increment 3 from `TODO/ROADMAP.md`:

- a reliable flat participant/task view extracted from explicit task activities;
- task title, task ID, role, model, status, turn, and tool-use metadata when available;
- parent/child hierarchy represented only when the stored data contains an explicit relationship;
- paths such as `main.subagent1.subagent1a` only when parentage is known;
- schemas, tests, and Skill examples for flat participants and explicit trees.

Increments 1 and 2 are complete. This increment must not add browser-profile, IndexedDB, LevelDB, cloud, or broad filesystem discovery, and must not add a redaction mode.

## Objective

Make it possible for an agent to answer a question Increments 1 and 2 cannot answer: **who worked on this thread, and what did each of them do?**

The primary workflows should be:

```bash
t3-session participants THREAD_ID --format json

t3-session participants THREAD_ID --format human

t3-session participants THREAD_ID --tree --format json

t3-session participants THREAD_ID --turn TURN_ID --format jsonl
```

The implementation remains local, read-only, SQLite-first, and based on the existing projection tables.

## Data reconnaissance

These facts were measured against a real local projection (111 threads, 28,330 activities) before this plan was written. Implementers must not invent fields beyond this set; if a field is absent from a payload, it is absent from the output.

Task participants come from `projection_thread_activities` rows whose `kind` begins with `task.`:

| kind | rows observed |
| --- | --- |
| `task.progress` | 4,446 |
| `task.completed` | 757 |
| `task.started` | 756 |
| `task.updated` | 379 |

The complete top-level key union across all 6,338 `task.*` payloads, with the number of rows carrying each key:

```text
taskId 6338    title 6071      detail 5654     usage 4581      lastToolName 4140
taskType 2202  agentKind 1967  model 1967      effort 1935     toolUseId 1935
role 1499      status 1148     summary 839     typedUsage 595  endedAt 375
outputFile 375 usageSnapshot 305               parentAgentId 32               agentIndex 32
phaseIndex 32  phaseTitle 32   attempt 32      timelineBypass 32              error 23
workflowName 15                runHandles 12   phases 6        isBackgrounded 4
```

Observed enumerated values:

- `role`: `general-purpose`, `claude`, `Explore`, `Plan`, and model-named roles such as `gpt-5-5`.
- `agentKind`: `agent`, `background`.
- `taskType`: `local_agent`, `local_bash`, `local_workflow`.
- `status`: `completed`, `failed`, `stopped`, `cancelled`.
- `effort`: `low`, `high`, `xhigh`.

Nested shapes: `usage` has `duration_ms`, `tool_uses`, `total_tokens`; `typedUsage` has `durationMs`, `toolUses`, `totalTokens`; `runHandles` has `runId`, `scriptPath`, `transcriptDir`.

Findings that determine this increment's contract:

1. **`taskId` is universal.** Every `task.*` row carries it, so a flat view is always derivable.
2. **Parentage is explicit but rare.** `parentAgentId` appears on 32 of 6,338 rows (about 0.5 percent), in 1 thread of 111, always alongside the workflow fields `agentIndex`, `phaseIndex`, `phaseTitle`, `attempt`. Where present it resolved to a real `taskId` in the same thread in every observed case (3 of 3 distinct parents). There is no `parentTaskId`, `depth`, `ancestor`, or `spawnedBy` field on any `task.*` payload.
3. **Tool activities do not identify their caller.** `tool.*` payloads carry only `detail`, `itemType`, `data`, and `status`, where `data` has `toolName`, `input`, and `result`. The only `taskId` inside a tool payload is `data.input.taskId`, which is an *argument* to a tool call, not the identity of the agent that made the call. Tool activities therefore cannot be used to reconstruct parentage.
4. **Task activities are turn-associated.** Only 98 of 6,338 `task.*` rows have a null `turn_id`.
5. **Threads can be participant-heavy.** The busiest observed thread has 261 distinct `taskId` values, so the participant view must be bounded and must not require loading full history.

The roadmap's judgement is therefore confirmed: **the flat view is the deliverable, and hierarchy is a conditional enrichment that is absent for the overwhelming majority of real threads.**

## Existing implementation to preserve

- `src/cli.js` parses arguments and dispatches `list`, `get`, `tail`, `find`, `doctor`, `schema`, and `install`.
- `src/index.js` exposes `createT3SessionClient()` with `listThreads()`, `getThread()`, `tailThread()`, `findThreads()`, `readRawJsonl()`, and `doctor()`.
- `src/query-options.js` owns all shared option validation and runs before SQLite is opened.
- `src/sqlite-store.js` owns read-only SQLite access, required-schema validation, and all queries.
- `src/normalize.js` converts SQLite rows into versioned normalized objects.
- `src/record-order.js` owns the shared chronological comparator.
- `src/tail.js` owns the polling engine.

Do not change storage root resolution, provider raw JSONL behavior, installer behavior, list, bounded-retrieval, tail, or live-state semantics.

The Increment 1 null-timestamp rule must be preserved: records with a null ordering timestamp sort last, in both directions.

## Participant contract

### Deriving a participant

A participant is one `taskId` within one thread. Build it by folding every `task.*` activity that shares a `taskId`, in the Increment 1 chronological activity order (`created_at`, then `sequence`, nulls last).

Fold rules:

- **Last non-null wins** for every scalar field. A later `task.progress` that omits `model` must not erase the `model` recorded by `task.started`.
- `firstSeenAt` is the `created_at` of the earliest contributing activity; `lastSeenAt` is the `created_at` of the latest.
- `turnId` is the turn of the earliest contributing activity, since that is the turn that started the task. Record `turnIds` as the sorted set of every turn the task's activities touched, because a background task can outlive the turn that started it.
- `activityCount` is the number of contributing activities.
- `status` is taken from the latest activity that carries one. A participant with no `status` field at all is reported as `status: null` and `state: "unknown"` — never guessed as running or completed.

Derive a small `state` summary separately from the raw `status`, using a frozen exported constant for the terminal set, exactly as `TERMINAL_TURN_STATES` works in Increment 2:

- `TERMINAL_TASK_STATUSES` = `completed`, `failed`, `stopped`, `cancelled`.
- `state` is `"finished"` when `status` is terminal, `"running"` when the participant has activities but no terminal status, and `"unknown"` when no status was ever recorded.

Treat an unrecognised status as non-terminal and report `state: "running"`, for the same reason Increment 2 treats an unknown turn state as non-terminal: claiming a still-running agent has finished is the more damaging error.

### Participant object

```json
{
  "taskId": "TASK_ID",
  "parentTaskId": null,
  "path": null,
  "depth": 0,
  "title": "Review the diff",
  "role": "general-purpose",
  "model": "MODEL",
  "agentKind": "agent",
  "taskType": "local_agent",
  "effort": "high",
  "status": "completed",
  "state": "finished",
  "summary": null,
  "detail": null,
  "error": null,
  "toolUseId": "TOOL_USE_ID",
  "lastToolName": "Read",
  "workflowName": null,
  "outputFile": null,
  "isBackgrounded": false,
  "turnId": "TURN_ID",
  "turnIds": ["TURN_ID"],
  "firstSeenAt": "2026-08-12T10:00:00.000Z",
  "lastSeenAt": "2026-08-12T10:04:00.000Z",
  "activityCount": 12,
  "usage": { "totalTokens": null, "toolUses": null, "durationMs": null }
}
```

Field rules:

- Every field above is always present. Absent projection data yields `null`, never a missing key, so consumers do not have to distinguish the two.
- `usage` is normalized from whichever of `typedUsage` or `usage` is present, preferring `typedUsage` because it is already camelCase. Map `total_tokens`/`totalTokens`, `tool_uses`/`toolUses`, and `duration_ms`/`durationMs`. Unknown values are `null`, not `0`.
- Do not copy `phases`, `runHandles`, `timelineBypass`, `usageSnapshot`, `attempt`, `agentIndex`, `phaseIndex`, or `phaseTitle` into the top-level participant object. Put anything projected but unmodelled under `adapterSpecific`, following the existing `addAdapterSpecific` convention in `src/normalize.js`.
- `title` and `summary` are conversation-adjacent content. They are included because the roadmap requires task title, but the participant view must not include message text, tool arguments, or tool results.

### Hierarchy

`parentTaskId` is populated **only** from an explicit `parentAgentId` on a contributing activity, and **only** when that value resolves to another participant's `taskId` in the same thread. In every other case `parentTaskId` is `null`.

Rules, all of which are non-negotiable:

- Never infer parentage from timestamps, activity order, `sequence`, task ID similarity, `toolUseId`, `agentIndex`, or nesting of turns. If `parentAgentId` is absent, the participant is a root. This is the roadmap's central constraint and the reason the flat view is the deliverable.
- A `parentAgentId` that does not resolve to a known participant is recorded as an unresolved edge: leave `parentTaskId` null and add a warning with code `UNRESOLVED_PARENT`, carrying the unresolved identifier. Do not drop the participant and do not invent a placeholder parent.
- Detect and break cycles. A malformed projection that makes A the parent of B and B the parent of A must not hang or overflow the stack: treat the participants in a cycle as roots and emit a warning with code `PARENT_CYCLE`.
- `depth` is 0 for a root and `parent.depth + 1` otherwise, computed only through resolved edges.

### Paths

`path` is a dotted string such as `main.subagent1.subagent1a`, and is populated **only** when the participant's entire ancestry to a root is explicitly known and resolvable. Otherwise `path` is `null`.

- The synthetic first segment is always `main`, representing the thread's own main agent, which is not itself a task activity.
- Sibling segments are `subagent1`, `subagent2`, and so on for depth 1; at depth 2 a child of `subagent1` is `subagent1a`, `subagent1b`; at depth 3, `subagent1a1`, `subagent1a2`, alternating numeric and alphabetic per level.
- Sibling numbering follows the deterministic participant ordering below. **Ordering siblings is not the same as inferring nesting**: the parent/child edge itself always comes from `parentAgentId`, and only the label assigned to an already-known child is positional. Do not let this rule be misread as permission to infer hierarchy from order.
- A participant whose `parentTaskId` is null is a root and gets the path `main.subagentN`. A participant with an unresolved parent gets `path: null`, because its position in the tree is genuinely unknown.

### Ordering

Participants are ordered by `firstSeenAt`, then by `taskId` as a deterministic tie-breaker, both ascending, with null `firstSeenAt` sorting last in both directions. Add `--reverse` for newest-first, matching `list` and `find`.

Reuse the null-timestamp rule; do not reimplement it inconsistently.

### Envelope

```json
{
  "schemaVersion": "t3-session.participants.v1",
  "toolVersion": "0.2.0",
  "threadId": "THREAD_ID",
  "ordering": { "sortBy": "firstSeenAt", "direction": "asc" },
  "selection": null,
  "counts": { "participants": 3, "roots": 1, "withExplicitParent": 2, "unresolvedParents": 0 },
  "hierarchyAvailable": true,
  "participants": [],
  "warnings": []
}
```

- `hierarchyAvailable` is `true` only when at least one participant has a resolved `parentTaskId`. It is the machine-readable signal that a tree is meaningful for this thread. For the great majority of real threads it will be `false`, and that is the expected, correct answer — not a failure.
- `selection` is `null` for a whole-thread read and carries the turn selection when `--turn` or `--turn-limit` is used, mirroring the Increment 1 `selection` shape.

## CLI contract

### `participants`

```bash
t3-session participants THREAD_ID
```

Supported options:

```text
--tree                 Emit a nested tree instead of a flat array
--turn <turn-id>       Only participants whose activities touch that turn
--turn-limit <n>       Only participants touching the newest n turns
--turn-offset <n>      Skip turns from the newest side before --turn-limit
--reverse              Newest-first instead of the default oldest-first
--limit <n>            Maximum participants returned
--offset <n>           Skip participants before applying --limit
--format human|json|jsonl
```

Rules:

- Reuse `normalizeTurnSelection` and `normalizeCount` from `src/query-options.js`. Add no second validation style. Validation runs before SQLite is opened.
- `--tree` is supported for `--format json` and `--format human`, and rejected for `--format jsonl`, because JSONL is a flat one-record-per-line contract and a nested tree cannot be expressed in it without inventing a second envelope.
- `--tree` on a thread with no explicit parentage returns every participant as a root. That is correct output, not an error.
- Reject `--title`, `--raw-jsonl`, `--once`, `--interval`, `--max-cycles`, `--timeout`, and the `list`-only filters `--project`, `--since`, `--before`, following the existing per-command rejection tables.
- `participants` is a storage command, so add it to both `COMMANDS` and `STORAGE_COMMANDS`.
- A thread that exists but has no task activities returns a valid envelope with an empty `participants` array, `counts.participants: 0`, and `hierarchyAvailable: false`. It is **not** a `ThreadNotFoundError`.
- A missing thread is `ThreadNotFoundError`, exit 2, nothing on stdout, exactly as `get`.

### `--format jsonl`

Emit `t3-session.jsonl-record.v1` records, adding `"participant"` to that schema's `recordType` enum as an additive change, exactly as `"list"` was added in Increment 1. A `participants` header record carries the envelope metadata, followed by one `participant` record per participant. Do not create a new JSONL record schema.

### Existing commands

`list`, `get`, `tail`, `find`, `doctor`, `schema`, and `install` keep their current behavior and output shapes.

**Do not add participants to `thread.v1`.** `get --format json` is already carrying `selection` and `liveState`, a participant fold is a different concern with its own bounding and ordering needs, and a third always-present array would change `get` output for every consumer that does not want it. The dedicated command with its own schema is the decision; record it in the README compatibility section. Add `t3-session schema participants.v1` to the schema command.

## Node API

```js
const view = await client.listParticipants(threadId, {
  turnId,
  turnLimit,
  turnOffset,
  reverse,
  limit,
  offset,
  tree: false,
});
```

Requirements:

- Validate options in the library layer through `src/query-options.js`, so a library caller cannot bypass validation.
- Return the same envelope the CLI serializes.
- Export the participant normalizer and the terminal-status constant from `src/index.js` so consumers and tests can use them directly.

## Data access design

Add to `src/sqlite-store.js`:

- a parameterized query returning `task.*` activity rows for one thread, ordered by the Increment 1 activity ordering key, restricted to `deleted_at IS NULL` on the parent thread;
- a variant bounded by a turn selection, reusing the existing turn-window machinery rather than duplicating it.

Constraints:

- Use `kind LIKE 'task.%'` with the pattern as a bound parameter, or an explicit `kind IN (?, ?, ?, ?)` list built from a frozen constant with placeholders generated from the array length. Never interpolate a user-supplied value into SQL. The only permitted interpolations remain whitelisted `ASC`/`DESC` tokens derived from a boolean and placeholder groups generated from an array length.
- Do not add anything to `REQUIRED_TABLES` or `REQUIRED_COLUMNS`. Every column needed is already required; adding a requirement would turn a previously healthy installation into a schema error.
- The busiest observed thread has 261 participants and several thousand task activities, so select only the columns needed and fold in JavaScript rather than issuing a query per task.

Add to `src/normalize.js` (or a new `src/participants.js` if `normalize.js` grows past a comfortable size — the main agent decides at implementation time):

- `TERMINAL_TASK_STATUSES` as a frozen exported constant;
- `normalizeParticipants(rows, options)` implementing the fold, hierarchy resolution, cycle detection, and path assignment;
- `buildParticipantTree(participants)` for `--tree`.

## Output schemas

- Add `schemas/participants.v1.json` for `t3-session.participants.v1`, covering the envelope, the participant object with every field above, the nested `children` array used by `--tree`, and the warning shape.
- Add `"participant"` to the `recordType` enum in `schemas/jsonl-record.v1.json`.
- Register `participants.v1` in `src/schema.js`, add it to `requiredReleaseFiles` and the version map in `test/package.test.js`, and add it to the `schema` command's expected-name string in `src/cli.js`.

## Tests required before review

Tests are part of the implementation. No test may depend on real elapsed time.

Extend `test/fixtures/sqlite-fixture.js` with task activities **without changing the existing doctor counts asserted by `test/sqlite-store.test.js` and `test/cli.test.js`** (`{ threads: 9, messages: 8, activities: 6 }`). Because those counts are exact, add participant fixtures to a **new** fixture builder in a new module, for example `test/fixtures/participant-fixture.js`, that creates its own database rather than mutating the shared one. Any test asserting new counts must use the new fixture.

The new fixture must cover: a thread with no task activities; a thread with flat participants only; a thread with an explicit `parentAgentId` chain three levels deep; a participant whose `parentAgentId` does not resolve; a two-node parent cycle; a participant with no `status`; a participant whose later activities omit fields set by `task.started`; participants sharing a `firstSeenAt` to exercise the tie-breaker; and a participant with a null `created_at`.

### Participant extraction tests

- multiple `task.*` activities sharing a `taskId` fold into exactly one participant;
- last non-null wins, and a later activity omitting a field does not erase it;
- `firstSeenAt`, `lastSeenAt`, `activityCount`, `turnId`, and `turnIds` are computed correctly;
- terminal statuses map to `state: "finished"`, a missing status maps to `"unknown"`, and an unrecognised status maps to `"running"`;
- `usage` is normalized from `typedUsage` and from snake_case `usage`, preferring `typedUsage`, with unknown values null rather than zero;
- unmodelled projected keys land in `adapterSpecific` and never at the top level;
- a thread with no task activities returns an empty, valid envelope rather than an error;
- ordering is oldest-first by `firstSeenAt` with a `taskId` tie-breaker, `--reverse` flips it, and a null `firstSeenAt` sorts last in both directions.

### Hierarchy tests

- a resolvable `parentAgentId` produces `parentTaskId`, `depth`, and a `path`;
- `hierarchyAvailable` is `false` for a thread with no explicit parentage and `true` when at least one edge resolves;
- an unresolved `parentAgentId` leaves `parentTaskId` null, sets `path` to null, and emits an `UNRESOLVED_PARENT` warning;
- a parent cycle terminates, treats the members as roots, and emits a `PARENT_CYCLE` warning;
- paths are `main.subagent1`, `main.subagent1a`, `main.subagent1a1` down three levels, and sibling numbering is deterministic across repeated runs;
- **parentage is never inferred**: a fixture where two tasks are adjacent in time and sequence, with no `parentAgentId`, must produce two roots and `hierarchyAvailable: false`. This is the single most important test in the increment;
- `--tree` nests resolved children and returns all participants as roots when no edge exists.

### CLI tests

- `participants` parses options before and after the command;
- `--format json`, `human`, and `jsonl` all work, and the JSONL header plus one record per participant validates against `jsonl-record.v1`;
- `--tree` is rejected with `--format jsonl` and accepted with `json` and `human`;
- turn selection, `--limit`/`--offset`, and `--reverse` bound and order the output;
- rejected options return the existing machine-readable error with exit code 3;
- a missing thread exits 2 with nothing on stdout; a thread with no participants exits 0 with an empty array;
- stdout stays clean for machine-readable formats and diagnostics stay on stderr;
- help text documents every Increment 3 option;
- every emitted envelope validates against `schemas/participants.v1.json`.

### Read-only tests

- participant reads do not modify the database: size and mtime unchanged;
- the participant query runs inside the existing deferred-transaction, read-only path.

## Skill and documentation work required before review

Update the README, `skills/t3-session/SKILL.md`, and its references with these examples:

```bash
t3-session participants THREAD_ID --format json
t3-session participants THREAD_ID --tree --format json
t3-session participants THREAD_ID --turn TURN_ID --format jsonl
```

The Skill must teach agents to:

1. use `participants` to answer "who worked on this thread", instead of guessing from message text or tool activity;
2. read `hierarchyAvailable` before presenting any tree, and state plainly that hierarchy is unavailable when it is `false` — which is the common case;
3. never present a flat list as a hierarchy, and never claim one agent invoked another unless `parentTaskId` is populated;
4. treat `state` rather than raw `status` for a quick answer, and report `"unknown"` honestly;
5. report `UNRESOLVED_PARENT` and `PARENT_CYCLE` warnings rather than hiding them;
6. bound the view with `--turn`, `--turn-limit`, or `--limit` on participant-heavy threads;
7. combine `participants` with Increment 2's `liveState` when a thread is still active, since a `running` participant on a settled thread usually means the task ended without a terminal status being projected.

Add troubleshooting for: a thread with no participants; a tree that is unexpectedly flat; and a participant stuck in `running`.

Remember that `skills/t3-session/` files are copied by an allowlist in `src/skill-install.js`. Editing the three existing skill files needs no installer change; adding a new file does.

## Implementation sequencing

The main agent lands the shared foundation first, so parallel agents code against fixed contracts: the participant option validation in `src/query-options.js`, the frozen `TERMINAL_TASK_STATUSES` constant, the participant fold and hierarchy resolver signature, the new participant fixture module, and the `src/index.js` wiring that pins every function name and signature.

Then work in waves of disjoint file ownership:

1. Participant extraction and hierarchy resolution, plus their tests.
2. SQLite queries and the bounded turn-selection variant, plus their tests.
3. CLI wiring, schemas, README, and Skill examples.

Each subagent must receive exact instructions and an explicit, disjoint file scope, and must not launch its own subagents. Hold all review until every implementation task is finished and the suite passes. Use no more than three review loops.

## Definition of done

Increment 3 is complete only when:

- a flat participant view is derived from explicit task activities and is always available;
- task title, task ID, role, model, status, turn, and tool-use metadata are included when the projection provides them, and are null when it does not;
- parent/child hierarchy is represented only from an explicit, resolvable `parentAgentId`, and is never inferred from timestamps, order, or identifier shape;
- `hierarchyAvailable`, `UNRESOLVED_PARENT`, and `PARENT_CYCLE` make the limits of the data machine-readable;
- paths are emitted only when the full ancestry is known;
- schemas, help output, README, and Skill examples describe the new contracts;
- the implementation remains read-only and SQLite-first;
- no test depends on real elapsed time;
- syntax checks pass and the complete test suite passes;
- no unresolved Increment 3 issues remain after review.
