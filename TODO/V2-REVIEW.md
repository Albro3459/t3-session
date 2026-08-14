# V2 review — Increments 1-3

Review of branch `v2` at `4ca98a6` against `TODO/ROADMAP.md` and the three increment plans.
Method: three scoped plan-vs-code audits (one per increment) plus direct verification against the
real local projection at `~/.t3/userdata/state.sqlite` and against the published `0.1.0` binary.

## Verdict

All three increments are implemented and land what their plans specify. `npm run check` is clean and
`npm test` is 207/207 with 0 skipped, 0 todo (re-run independently for this review). `npm pack --dry-run`
ships 32 files, 53.5 kB, with no `TODO/` leakage.

The work is publishable. The findings below are one behavior bug worth fixing, two doc errors, and a
set of coverage and polish gaps — none of them blocking a `0.2.0` pre-release.

## What was implemented

### Increment 1 — listing, bounded retrieval, chronological output

Complete. `list` with `--project/--since/--before/--limit/--offset/--reverse`, deterministic
`updated_at` ordering with a `thread_id` tie-break in the same direction, `limit+1` pagination with
`hasMore`, bounded `get` via `--last-turn/--turn/--turn-limit/--turn-offset`, chronological normalized
JSONL, the additive `selection` field on `thread.v1`, `schemas/list.v1.json`, and matching Node API.
Validation is centralized in `src/query-options.js` and provably runs before SQLite opens.

Verified against real data: `list --limit 2 --format json` and `--reverse` return correct pages and
`hasMore`; `get --format json` output is byte-comparable to published `0.1.0` plus `liveState`
(same `thread`/`messages` key sets); `get --format jsonl` returns the same 368 records as `0.1.0` in
chronological rather than grouped order, matching the documented correction.

### Increment 2 — live state and tailing

Complete. `liveState` is always present on `getThread()` and describes the thread rather than the
retrieval window (dedicated query at `src/sqlite-store.js:432`). `tail` polls the projection read-only
with a fresh connection per cycle, emits `upsert`/`live-state`/`end` records against
`schemas/tail-record.v1.json`, supports `--once/--interval/--max-cycles/--timeout/--turn-limit`, and
handles SIGINT, EPIPE, transient database failure with retry, and mid-tail thread deletion.

Verified against real data: `tail <live-thread> --once --format jsonl` emits the full cycle-1 baseline,
one `live-state` record, and exactly one `end` record with `reason: "once"`.

### Increment 3 — participants and hierarchy

Complete. `participants` folds `task.*` activities into one entry per `taskId` (last-non-null-wins),
resolves parentage only from an explicit, resolvable `parentAgentId`, detects cycles, assigns
`main.subagentN[a][1]` paths only when the full ancestry is known, and exposes `hierarchyAvailable`,
`counts`, and `UNRESOLVED_PARENT`/`PARENT_CYCLE`/`PARENT_OUT_OF_PAGE` warnings.

Verified against real data — this is the strongest evidence in the review:

- Thread `b0950739` (125 participants) produces `hierarchyAvailable: true`, `withExplicitParent: 16`,
  and genuinely nested output such as `main.subagent56.subagent56d`, sourced from real `parentAgentId`
  values on workflow phase tasks. Human `--tree` indents correctly; JSON `--tree` nests correctly.
- Path labels are assigned in canonical order *before* paging, so they stay stable under `--reverse`,
  `--limit`, and `--offset` — a real risk the implementation avoided.
- Unmodeled projection keys (`agentIndex`, `phaseIndex`, `phaseTitle`, `attempt`, `timelineBypass`)
  land in `adapterSpecific` rather than being dropped.
- Empty thread returns a valid empty envelope with exit 0; missing thread exits 2 with zero bytes on
  stdout.

## What is left

Nothing in Increments 1-3 is unimplemented. Remaining work is the fix list below plus items the plans
explicitly deferred: tail deletions, redaction mode, and anything beyond the SQLite projection.

## Key decisions

1. **Additive-only schema evolution.** `list.v1`, `tail-record.v1`, and `participants.v1` are new
   schemas; `thread.v1` gained optional `selection` and always-present `liveState` rather than a v2.
   Confirmed against the published binary: `get --format json` is `0.1.0`'s shape plus `liveState`.
2. **Participants are a separate command, not part of `thread.v1`.** Keeps `get` output unchanged for
   consumers that do not want a third array.
3. **Hierarchy is never inferred.** Only `parentAgentId` creates an edge. Sibling *labels* are
   positional, which the plan explicitly distinguishes from inferring nesting; the implementation
   honors that distinction.
4. **Chronological-by-default ordering** for `list`, `find`, and normalized JSONL, with `--reverse` to
   restore newest-first. This changed `find` and JSONL behavior versus `0.1.0`; documented as a pre-1.0
   correction.
5. **`turnId` keeps the first non-null `turn_id`** rather than the literal turn of the earliest
   contributing activity (`src/participants.js:183`). Defensible — it avoids reporting `turnId: null`
   when a real turn is known — but it is a silent divergence from the plan's wording, is documented
   only in a code comment, and has no fixture where an early activity has a null `turn_id`.
6. **Accepted limitations rather than speculative fixes**: null-`turn_id` activities stay invisible to
   turn-bounded reads (matches `get` window semantics), quadratic path memory at unreachable scale, and
   no depth cap. All reasonable; item 5 and the null-`turn_id` case are the two a consumer can actually
   hit.

Note a tension worth ratifying: Increment 3's definition of done says "no unresolved Increment 3 issues
remain after review," and these limitations are resolved by documentation and acceptance, not by fixes.
That is a legitimate reading, but it is a judgment call, not a satisfied criterion.

## Issues

Ranked. Every item was confirmed by reading the code; severity reflects real-world reachability.

### 1. Turn-scoped reads manufacture spurious `UNRESOLVED_PARENT` warnings — behavior bug

`retrieveParticipantActivityRows` fetches only activities tagged with the selected turns
(`src/sqlite-store.js:539-549`), so `resolveHierarchy` (`src/participants.js:264-284`) never sees a
parent whose own activities fall outside the window. Failure: task A works only in turn T1; task B
records `parentAgentId = A` and works in T2. `participants THREAD --turn T2` reports B with
`UNRESOLVED_PARENT` and `counts.unresolvedParents: 1` — indistinguishable from genuinely corrupt
projection data. The identical ambiguity for `--limit`/`--offset` was already solved with a distinct
`PARENT_OUT_OF_PAGE` code (`src/participants.js:444-458`); turn windows never got the equivalent.
Fix: either resolve parents against the unscoped task set, or emit a distinct `PARENT_OUT_OF_SELECTION`
code. Cheap, and it removes a warning that will make an agent claim the data is broken.

### 2. README states published `0.1.0` covered Increment 1 — false

`README.md:302` says "`0.1.0` covered Increment 1 only." Published `0.1.0` (verified via `npm view` and
`git show main:src/cli.js`) has no `list` command and no `listThreads` export; all of Increment 1 is
unreleased and ships first in `0.2.0`. Anyone reading the compatibility policy will believe a released
version has features it does not have.

### 3. Stale comment contradicts the corrected `counts` scoping

`src/participants.js:441` still reads "counts and hierarchyAvailable describe the whole thread." Commit
`eef34bc` established that a turn selection narrows what those fields are computed from, and
`references/cli.md:197` documents the corrected behavior. The comment is the old, wrong claim sitting
directly above the code it describes.

### 4. `BEGIN DEFERRED`/`ROLLBACK` bypass database-error classification

`database.exec("BEGIN DEFERRED")` and the `finally`-block `ROLLBACK` are unguarded in
`readThreadFromDatabase` (`src/sqlite-store.js:689-696`), `findThreadsFromDatabase`,
`listThreadRowsFromDatabase`, and `readThreadWindowFromDatabase`, unlike `queryAll`
(`src/sqlite-store.js:400`), which rewraps as `DatabaseUnavailableError`. A raw throw there reaches
`toT3SessionError` (`src/errors.js:143`) and gets the default `exitCode: 1` / code `T3_SESSION_ERROR`
instead of exit 4 / `DATABASE_UNAVAILABLE`, contradicting the Increment 2 retry contract. Likelihood is
low — a deferred transaction takes no lock, so `SQLITE_BUSY` at `BEGIN` is close to unreachable — but
the `finally` `ROLLBACK` is the more plausible half: if it throws, it *replaces* an already-correctly
classified error. Fix is one shared wrapper.

### 5. `liveState.complete` can be `true` on a thread that is actively working

Observed on this machine: while this very session was mid-turn, the projection's newest turn row was
`state: "completed"` with `completed_at` ten minutes earlier, and `tail --once` accordingly reported
`status: "idle"`, `complete: true`. The cause is upstream projection content, not the tool's logic —
`liveState` faithfully reports projected signals and correctly refuses to infer activity from timestamp
recency. But `SKILL.md:40` tells agents to read `complete` and say the thread is still active only when
it is `false`, which gives false confidence in exactly this case. Worth one honest sentence in the docs:
`complete: true` means the projection shows no in-flight signal, not that no agent is working.

### 6. Increment-1 timezone ambiguity in `--since`/`--before`

`normalizeTimestamp` (`src/query-options.js:14-29`) accepts a date-time without an offset and passes it
to `new Date(...)`, which parses date-time-without-offset in the host's local zone while stored values
are UTC. `--since 2026-08-10T09:00:00` on a UTC-5 host silently filters from 14:00 UTC. Not documented,
not tested (every test timestamp uses `Z`). Either reject offset-less date-times or document the rule.

## Test coverage

Strong overall, and the discriminating-vs-vacuous distinction was actually checked rather than assumed.
207 tests: 80 CLI, 38 participants, 35 sqlite-store, 19 tail, 15 live-state, 14 ordering, plus fixtures.
Ordering and tie-break tests use equal and null timestamps and assert exact IDs; the tail diff test
mutates message text without touching `updated_at`, defeating a naive diff; validate-before-open is
proven by passing a nonexistent database path; the participants envelope validator genuinely walks
`schemas/participants.v1.json` and is itself guarded by 15 mutation cases.

Gaps, in priority order:

1. **Busy/locked SQLite is never really exercised.** Every transient-failure test either injects a
   `DatabaseUnavailableError` directly or deletes the database file. Nothing provokes real lock
   contention, which is precisely why issue 4 is invisible to the suite.
2. **No test for the turn-scoped `UNRESOLVED_PARENT` case** in issue 1 — the fixture set has no task
   whose parent lives in a different turn.
3. **`--turn-limit` defaulting to 1 when only `--turn-offset` is given** is a plan-named contract
   (`src/query-options.js:185`) with zero direct coverage; every test that sets `turnOffset` also sets
   `turnLimit`.
4. **`isBackgrounded: false`** is a single-activity specification assertion, as the implementer already
   flagged. It does not exercise boolean folding across activities.
5. **`turnId` first-non-null behavior** (decision 5) has no fixture with a null-then-non-null sequence.

The deep-chain test at `--stack-size=384` was independently re-checked and does discriminate: a
recursive port carrying the real per-frame cost overflows at that stack size and depth, while a
trivial-body recursion does not. Its margin is frame-size dependent, so it is sound here rather than
architecture-proof — accurately described by the implementer.

## Docs and Skill

Content is accurate and complete; the problem is density and shape, not correctness.

- **README** is 323 lines / 24.7 kB, with a compatibility section (`README.md:294-308`) that has become
  an embedded changelog. Split the three pre-1.0 corrections and the version history into `CHANGELOG.md`
  and leave the policy statement in the README.
- **`SKILL.md`** is 103 lines. The frontmatter description is a single ~90-word run-on sentence. The
  Examples section is four unlabeled code blocks with duplicated entries (`get THREAD_ID --format json`
  appears twice); group them by task with a one-line heading each.
- **Missing Skill examples**: `schema <name>`, `install --skills`, `--turn-offset`, participants
  `--limit/--offset/--reverse`, and `tail --timeout`. All are documented options with no example.
- **`references/cli.md`** is 22 kB. Correct, but passages like the `counts`-scoping paragraph at line
  197 are single blocks of prose doing the work of a table.
- **Roadmap vocabulary leaks into shipped docs**: "Increment 1/2/3" appears five times across `README.md`
  and the skill references. An npm consumer has no idea what those refer to.
- **Human `participants` output** (`src/output.js:264-278`) omits `agentKind`, `taskType`, `effort`,
  `usage`, and timestamps. Fine as a summary, but it under-answers "what did each of them do" compared
  to the JSON.

## Recommended before publishing 0.2.0

1. Fix issue 1 (distinct warning code or unscoped parent resolution) and add the missing fixture.
2. Correct `README.md:302` and the stale comment at `src/participants.js:441`.
3. Wrap `BEGIN DEFERRED`/`ROLLBACK` in the existing error classification (issue 4).
4. Add the `liveState.complete` caveat sentence (issue 5) and decide on `--since` timezone handling
   (issue 6).
5. Document the `turnId` first-non-null decision outside the code comment.
6. Docs pass: extract `CHANGELOG.md`, tighten the Skill description, regroup and extend the Skill
   examples, drop "Increment N" from shipped docs.

Items 1-3 are small and worth doing before the first publish; 4-6 are polish.
