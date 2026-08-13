---
name: "t3-session"
description: "Use when a T3 Code conversation thread must be recovered from the local read-only projection by exact thread ID, listed or filtered as a candidate, searched by title, diagnosed, inspected through provider JSONL, read as a bounded window of recent turns, checked for live/complete state, followed with a bounded tail while it is still active, or inspected for the task participants (and any explicit hierarchy) that worked on it."
---

# T3 Session Skill

Use the `t3-session` CLI to retrieve persisted T3 Code conversation threads without scanning arbitrary storage or changing T3 data. The SQLite projection is the primary source. Provider JSONL is an optional raw source for events that are not represented in the projection.

## Prerequisite check

Confirm the CLI is available before proposing commands.

```bash
command -v t3-session >/dev/null 2>&1
```

If it is not available, install the public package:

```bash
npm install -g @albro3459/t3-session
```

Use `t3-session --help` to print the current command reference.

## Recovery workflow

1. If the current task already provides an exact T3 thread ID, skip to step 3. Otherwise, list recent candidates instead of guessing a thread ID: `t3-session list --limit 20 --format json` (or `t3-session find --title "..." --format json` when a title fragment is known).
2. Narrow the listing deliberately with `--project`, `--since`, `--before`, `--limit`, `--offset`, and `--reverse` so results stay small and relevant. Pick a candidate thread ID from the returned metadata; do not open every candidate.
3. Confirm the candidate before retrieving full history: `t3-session get <thread-id> --last-turn --format json`. Only proceed to a full `t3-session get <thread-id>` once the candidate is confirmed to be the right thread.
4. Any output carrying a `selection` object (from `--last-turn`, `--turn`, `--turn-limit`, or `--turn-offset`) is partial history. Say so explicitly; do not imply it is the whole conversation.
5. Use `--format json` when an agent or script needs the complete `thread.v1` object, and `--format jsonl` when a consumer needs one stable normalized record per line. JSONL records after the thread header are already chronological — rely on that order and do not re-sort records.
6. Use `--raw-jsonl` only when projection data is insufficient. Preserve and report warnings and machine-readable diagnostics rather than hiding them.
7. Run `t3-session doctor --format json` when the database or expected projection schema is unavailable. Avoid broad storage discovery, and avoid printing sensitive transcript content beyond what the task requires.

## Live state and following an active thread

Every `get` result carries a `liveState` object, and a thread can be actively changing. Follow these rules:

1. Read `liveState.complete` before summarizing a thread. If it is `false`, say plainly that the thread is still active — do not present an in-flight turn as finished.
2. Prefer `t3-session get THREAD_ID --last-turn --format json` for a one-shot check of current state, and `t3-session tail THREAD_ID --once --format jsonl` for a change-oriented check (what changed since a known point).
3. Inside an automated workflow, use a bounded tail — `--once`, `--max-cycles`, or `--timeout` — and never start an unbounded tail. An unbounded tail only makes sense in an interactive session where a human can interrupt it.
4. Treat every `upsert` tail record as replace-by-identifier, not append. A record seen for the first time and a record whose content changed both arrive as `upsert`; key on the record's stable identifier and replace rather than accumulating a log.
5. Rely on the chronological ordering of records within a tail cycle, the same ordering `get --format jsonl` uses. Do not re-sort records.
6. Report interruption, retry diagnostics, and partial reads honestly. If a tail ends with reason `"interrupt"`, stops after `--max-cycles` or `--timeout`, or hit retried database errors, say so — do not present a partial tail as a complete transcript.
7. Do not use provider JSONL to determine live state. The SQLite projection is canonical for `liveState`, and `tail` never opens the provider log.

## Thread participants

1. Use `t3-session participants THREAD_ID` to answer "who worked on this thread," instead of guessing participants from message text or tool activity.
2. Read `hierarchyAvailable` before presenting any tree. State plainly that hierarchy is unavailable when it is `false` — this is the common case for real threads, not a failure.
3. Never present a flat list as a hierarchy, and never claim one agent invoked another unless `parentTaskId` is populated. Hierarchy comes only from an explicit, resolvable `parentAgentId`; it is never inferred from timestamps, order, or identifier shape.
4. Prefer `state` over the raw `status` for a quick answer, and report `"unknown"` honestly rather than guessing that a task finished.
5. Report `UNRESOLVED_PARENT`, `PARENT_CYCLE`, and `PARENT_OUT_OF_PAGE` warnings rather than hiding them. `PARENT_OUT_OF_PAGE` means `--tree` was combined with `--limit`/`--offset` and a resolved parent fell outside the returned page; the child is surfaced at the top level instead of dropped. `hierarchyAvailable: true` can legitimately accompany a visually flat or partial tree when this warning is present — check the warning, not the shape of the tree.
6. Bound the view with `--last-turn`, `--turn`, `--turn-limit`, or `--limit` on participant-heavy threads — real threads have been observed with 261 distinct tasks. A `task.*` activity recorded with a null `turn_id` can never appear in a turn-bounded read; if an expected participant is missing from a bounded view, re-run without turn selection before concluding it is absent.
7. Combine `participants` with `liveState` when a thread is still active: a participant in `state: "running"` on a settled thread (`liveState.complete: true`) usually means the task ended without a terminal status being projected, not that it is still executing.

## Safe defaults

- Retrieval is read-only.
- The CLI uses `--home`, then `T3_HOME`, then the default T3 home.
- No recursive discovery or broad filesystem search is performed.
- Diagnostics are written to stderr for commands whose primary output is data.
- Do not print credentials, bearer tokens, private prompts, or unrelated files.

## Examples

```bash
t3-session list --reverse --limit 20 --format json
t3-session list --project "CodeLaunch" --since 2026-08-10 --format json
t3-session get THREAD_ID --last-turn --format json
t3-session get THREAD_ID --turn-limit 3 --format jsonl
t3-session get THREAD_ID --format jsonl
```

```bash
t3-session get THREAD_ID --format json
t3-session tail THREAD_ID --once --format jsonl
t3-session tail THREAD_ID --interval 2000 --format jsonl
t3-session tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
```

```bash
t3-session get THREAD_ID
t3-session get THREAD_ID --format json
t3-session get THREAD_ID --raw-jsonl
t3-session find --title "project topic" --format json
t3-session doctor --format json
```

```bash
t3-session participants THREAD_ID --format json
t3-session participants THREAD_ID --tree --format json
t3-session participants THREAD_ID --last-turn --format json
t3-session participants THREAD_ID --turn TURN_ID --format jsonl
```

If history is missing, malformed, or only partially available, preserve the CLI warning or error and say what was unavailable. Do not reconstruct a complete conversation from token deltas when a normalized SQLite projection is present.

## References

- CLI options and output contracts: `references/cli.md`
- Practical recovery and troubleshooting flows: `references/workflows.md`
