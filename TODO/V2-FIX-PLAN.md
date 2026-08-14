# V2 fix plan — 0.2.0 pre-publish

Derived from `TODO/V2-REVIEW.md` at `ba73e82`. Branch `v2`. Scope: the six review issues, the five
test-coverage gaps, and the docs/skill pass. Nothing here changes a schema version.

Execution model: the main agent orchestrates; Sonnet 5 subagents do the edits. Subagents run in
parallel only when their file sets are disjoint — file ownership below is exclusive per phase, and a
subagent may not touch a file it does not own. The main agent runs `npm run check` and `npm test`
between phases and makes every commit.

## Decisions taken before implementation

1. **Issue 1 fix shape**: emit a distinct `PARENT_OUT_OF_SELECTION` warning rather than resolving
   parents from outside the turn window. Turn-scoped reads keep meaning "activities in these turns";
   the warning removes the ambiguity, matching the `PARENT_OUT_OF_PAGE` precedent.
2. **No new `counts` field.** `PARENT_OUT_OF_SELECTION` carries the affected task IDs in
   `details.taskIds`. `counts.unresolvedParents` counts only genuinely unresolvable parents.
3. **Issue 6**: an offset-less date-time in `--since`/`--before` is interpreted as **UTC**, matching
   the date-only form (which ES already parses as UTC) and matching UTC storage. Documented + tested.
4. **`CHANGELOG.md` ships in the npm package** (added to `package.json` `files`).
5. Roadmap vocabulary ("Increment N") is removed from `README.md` and `skills/`; it stays in `TODO/`,
   which is not packed.

## Phase 1 — behavior fixes (2 subagents in parallel)

### 1A — turn-scoped parent resolution (issues 1 and 3, coverage gap 2)

Owns: `src/participants.js`, `src/sqlite-store.js`, `src/index.js`, `test/participants.test.js`.

- `retrieveParticipantActivityRows`: when a selection is active, also read the thread's task activity
  payloads unscoped, and return the thread-wide known task ID set alongside the windowed rows. Parse
  payloads in `participants.js` with the existing tolerant parser, not in SQL (`json_extract` throws
  on malformed JSON; the JS path degrades with a warning instead).
- `resolveHierarchy`: a `parentAgentId` that is absent from the selected entries but present in the
  thread-wide set gets `parentTaskId` populated, ancestry marked unknown (`path: null`), and one
  aggregated `PARENT_OUT_OF_SELECTION` warning with sorted `details.taskIds`. A parent absent from
  both sets stays `UNRESOLVED_PARENT` with `parentTaskId: null`, unchanged.
- Exclude out-of-selection children from the `PARENT_OUT_OF_PAGE` set so `--tree` never double-reports
  the same child under two codes.
- Fix the stale comment at `src/participants.js:441` to state the corrected scoping from `eef34bc`.
- Tests: parent-in-another-turn produces `PARENT_OUT_OF_SELECTION` and zero `unresolvedParents`; the
  same fixture read unscoped nests normally with a real `path`; a parent that exists nowhere still
  produces `UNRESOLVED_PARENT` under a turn selection (discriminating, not vacuous).

### 1B — timestamp timezone + turn-window default (issue 6, coverage gap 3)

Owns: `src/query-options.js`, `src/cli.js`, `test/cli.test.js`.

- `normalizeTimestamp`: a date-time without an offset is interpreted as UTC. Date-only, `Z`, and
  explicit-offset forms keep their current meaning.
- Tests: offset-less date-time normalizes identically to its `Z` form regardless of host `TZ`;
  explicit offsets still convert; `--since`/`--before` filtering over a fixture agrees.
- Test the plan-named contract that `--turn-offset` alone defaults `turnLimit` to 1.

**Commits**: `Distinguish out-of-selection parents from unresolved ones`, then
`Parse offset-less timestamps as UTC`.

## Phase 2 — error classification and fold coverage (2 subagents in parallel)

### 2A — transaction error classification (issue 4, coverage gap 1)

Owns: `src/sqlite-store.js`, `test/sqlite-store.test.js`. Starts only after 1A commits.

- One shared wrapper around `BEGIN DEFERRED` and the `finally` `ROLLBACK` in all four read paths, so a
  throw classifies as `DatabaseUnavailableError` (exit 4) like `queryAll` does. A `ROLLBACK` failure
  must not replace an already-classified in-flight error.
- Provoke real SQLite lock contention (writer holding an exclusive lock against a non-WAL database)
  and assert the exit code / error code. If real contention cannot be provoked deterministically in
  this runtime, say so in the report and cover the classification path directly instead — do not
  present an injected failure as real contention.

### 2B — participant fold coverage (coverage gaps 4 and 5)

Owns: `test/participants.test.js`. Starts only after 1A commits.

- `isBackgrounded` folding across multiple activities (last-non-null-wins), not a single-activity
  assertion.
- `turnId` first-non-null: a fixture whose earliest activity has a null `turn_id` and a later one has
  a real turn.

**Commits**: `Classify transaction failures as database errors`, then
`Cover participant fold across activities`.

## Phase 3 — docs and skill pass (3 subagents in parallel)

All three start only after phase 2 commits, so they describe shipped behavior including
`PARENT_OUT_OF_SELECTION` and the UTC rule.

### 3A — README and changelog (issue 2, docs density)

Owns: `README.md`, `CHANGELOG.md` (new), `package.json`, `test/package.test.js`.

- Correct the false claim that published `0.1.0` covered Increment 1: `0.1.0` has no `list` command;
  listing, bounded `get`, `liveState`/`tail`, and `participants` all ship first in `0.2.0`.
- Move version history and the three pre-1.0 corrections into `CHANGELOG.md`; leave the policy
  statement in the README.
- Drop "Increment N" everywhere in the README.
- Document the UTC rule for `--since`/`--before`.

### 3B — SKILL.md (issue 5, examples)

Owns: `skills/t3-session/SKILL.md`.

- Rewrite the frontmatter description as a short trigger sentence, not a ~90-word run-on.
- Replace the four unlabeled duplicate-carrying blocks with task-grouped blocks, one heading each,
  no repeated command. Add the missing examples: `schema <name>`, `install --skills`, `--turn-offset`,
  participants `--limit/--offset/--reverse`, and `tail --timeout`.
- Add the honest `liveState.complete` caveat: `true` means the projection shows no in-flight signal,
  not that no agent is working.
- Add `PARENT_OUT_OF_SELECTION` to the warnings rule. Condense prose to explicit agent-facing rules.

### 3C — references (density, decisions)

Owns: `skills/t3-session/references/cli.md`, `skills/t3-session/references/workflows.md`.

- Turn the `counts`-scoping paragraph into a table.
- Document `PARENT_OUT_OF_SELECTION`, the UTC timestamp rule, and the `turnId` first-non-null decision
  (currently only a code comment).
- Drop "Increment N". Condense to concise, explicit, example-backed entries.

**Commits**: `Extract changelog and correct the release history`, then
`Condense skill instructions and examples`.

## Phase 4 — main-agent review

`npm run check`, `npm test`, `npm pack --dry-run` (confirm no `TODO/` leakage and that `CHANGELOG.md`
is packed), then a read of every diff hunk against this plan and the review's recommendation list.
Report anything left undone rather than closing it silently.

## Not in scope

Deferred by the increment plans and unchanged here: tail deletions, redaction mode, non-SQLite
sources, human `participants` output enrichment (review's last docs bullet — a display change, not a
correctness one; call it out at the end rather than folding it into a docs pass).
