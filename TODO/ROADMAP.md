# t3-session roadmap

This roadmap separates the next work into three increments. Increment 1 is complete. Increment 2 is not authorized yet.

## Product constraints

- Keep the package SQLite-first and read-only.
- Use the existing normalized projection as the canonical source.
- Do not add browser-profile, IndexedDB, LevelDB, cloud, or broad filesystem discovery.
- Do not add redaction mode in these increments.
- Preserve clean machine-readable stdout and diagnostics on stderr.
- Every implementation increment must include code, tests, documentation, and Skill examples.
- Tests must pass before an increment is considered complete.

## Increment 1: listing, bounded retrieval, and chronological output

Implement the first agent-ergonomic features:

- Add `t3-session list`.
- Filter listings by project.
- Filter listings with `--since` and `--before` timestamps.
- Add bounded results with `--limit` and `--offset`.
- Make ordering deterministic and chronological by default.
- Add `--reverse` to request newest-first ordering.
- Add bounded thread retrieval for `--last-turn`, exact `--turn`, and a small turn window/pagination mechanism.
- Make normalized JSONL thread output chronological by default.
- Add versioned machine-readable list output and schema support where needed.
- Update the Node API to expose the same capabilities as the CLI.
- Add unit, SQLite integration, CLI, schema, ordering, filtering, and pagination tests.
- Update the README and bundled Skill references with command examples and recovery workflows.

Implementation details and acceptance criteria are in `TODO/INCREMENT-1-PLAN.md`.

## Increment 2: live state and tailing

Implement after Increment 1 is complete and reviewed:

- Add explicit completeness/live-state metadata to normalized thread output.
- Add a read-only `tail` command for live threads.
- Poll the SQLite projection rather than treating provider JSONL as the canonical transcript.
- Emit new records and in-place message/activity updates using an explicit operation such as `upsert`.
- Add `--once`, polling interval, interruption, and partial-read behavior.
- Add WAL/live-update fixtures and tests.
- Add Skill examples for checking an active thread and following updates.

Increment 2 must not be started as part of the current Increment 1 implementation.

## Increment 3: subagent participants and hierarchy

Implement after Increment 2 is complete and reviewed:

- Extract a reliable flat participant/task view from explicit task activities.
- Include task title, task ID, role, model, status, turn, and tool-use metadata when available.
- Represent parent/child hierarchy only when the stored data contains an explicit relationship.
- Support paths such as `main.subagent1.subagent1a` only when parentage is known.
- Never infer nesting solely from timestamps, task order, or task IDs.
- Add schemas, tests, and Skill examples for flat participants and explicit trees.

The current projection exposes task IDs and task metadata but does not reliably expose parent task IDs, so a flat view is the safe initial target for this increment.

## Agent implementation protocol

For implementation work, use one to three Sonnet 5 medium subagents at a time. The main agent owns orchestration, task decomposition, reasoning, integration decisions, and final review.

The main agent will tell each subagent exactly what to implement and which files or contracts they own. Subagents must follow those instructions and must not create or launch their own subagents.

Review is intentionally held until all implementation subagent tasks for the increment are finished and the implementation is complete with its tests and Skill examples. Tests must pass before review begins.

After implementation is complete, the main agent may review directly and may use fresh review subagents. There may be no more than three review loops for a single increment. A review loop includes findings, fixes, and re-verification.
