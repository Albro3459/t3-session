# Changelog

Notable changes to `t3-session`, by release. The package is pre-1.0; see the "Schema and
compatibility policy" section of `README.md` for the rules governing schema versioning.

## 0.2.0

`0.1.0` published with `get`, `find`, `doctor`, `schema`, and `install --skills` only — no `list`
command, no bounded `get`, no `liveState`, no `tail`, and no `participants`. All of those ship for
the first time in `0.2.0`.

### Added

- `list` command: paginated thread listing (`--project/--since/--before/--limit/--offset/--reverse`),
  new `t3-session.list.v1` envelope, matching `listThreads` API.
- Bounded `get`: `--last-turn/--turn/--turn-limit/--turn-offset` retrieve a window of turns instead
  of full history. Adds the additive `selection` field to `thread.v1`; full retrieval is unaffected.
- `liveState`: an always-present property on `thread.v1` describing whether a thread appears to
  still be changing, derived only from projected signals (turn state, streaming messages, provider
  session status), never from timestamp recency.
- `tail` command: polls the SQLite projection read-only and emits `upsert`/`live-state`/`end`
  records against the new `t3-session.tail-record.v1` schema.
- `participants` command: folds `task.*` activities into one entry per `taskId`, resolves hierarchy
  from explicit `parentAgentId` links only, and reports it under the new `t3-session.participants.v1`
  schema. `"participants"`/`"participant"` were added to the `t3-session.jsonl-record.v1`
  `recordType` enum as an additive change. Participants are a separate command rather than a third
  array on `thread.v1`, so `get` output is unaffected.
- `PARENT_OUT_OF_SELECTION` warning: under a turn selection (`--turn/--turn-limit/--turn-offset/
  --last-turn`), a task whose recorded parent is real but whose own activities fall outside the
  selected turns is now reported with its real `parentTaskId`, `path: null`, at the top level, and
  named in this warning — distinct from `UNRESOLVED_PARENT`, which now means only a parent that does
  not exist anywhere in the thread.

### Fixed

- `--since`/`--before` accept an offset-less ISO-8601 date-time — including the space-separated form
  (`2026-08-10 09:00`) — and interpret it as UTC, matching the date-only form and UTC storage,
  instead of the host's local timezone.

No schema version changed with this release: `thread.v1`, `list.v1`, `tail-record.v1`,
`jsonl-record.v1`, and `participants.v1` are all unchanged from their initial definitions.

### Pre-1.0 corrections

Behavior changes versus `0.1.0`, called out because they change output shape or ordering:

- Normalized JSONL (`get --format jsonl`) changed from grouped order (all turns, then all messages,
  then all activities) to chronological order by event timestamp.
- `find`'s default order changed from newest-first (`updated_at` descending) to oldest-first
  chronological, matching `list`; pass `--reverse` to restore newest-first. Ties now break
  deterministically on `thread_id`.
- `liveState` is a new always-present property on `thread.v1`, so `get --format json` output is no
  longer byte-identical to `0.1.0` output. Accepted as an additive change for a pre-1.0 package; it
  does not create a `thread.v2`.

## 0.1.0

First published release. Commands: `get`, `find`, `doctor`, `schema`, `install --skills`. `get`
retrieves full thread history only, with no bounded-window options.
