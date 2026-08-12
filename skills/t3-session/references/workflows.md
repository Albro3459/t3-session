# t3-session Workflows

Assume the CLI is installed and the thread ID comes from the current task context. Keep examples sanitized and do not substitute arbitrary filesystem searches for the documented paths.

## Find a thread without an exact ID

Use `list` to identify a candidate instead of guessing a thread ID:

```bash
t3-session list --reverse --limit 20 --format json
t3-session list --project "CodeLaunch" --since 2026-08-10 --format json
```

Narrow with `--project`, `--since`, `--before`, `--limit`, and `--offset` so the returned page stays small. `--reverse` returns the most recently updated threads first. Read `hasMore` in the response to know whether to page further with `--offset` rather than widening `--limit` unnecessarily. `list` output is metadata only (title, project, branch, worktree path, timestamps) — it never contains message or activity text, so it is safe to inspect broadly before committing to one thread ID.

## Confirm before full retrieval

Before retrieving the complete history of a candidate thread, confirm it with a bounded read:

```bash
t3-session get THREAD_ID --last-turn --format json
```

Check the thread metadata, the latest turn, and the most recent user prompt (included via `pending_message_id` even though projected user messages carry a null `turn_id`). Only run the full `t3-session get THREAD_ID` once the candidate is confirmed. Any response carrying a `selection` object is partial history — state that explicitly and do not present it as the full conversation. `t3-session get THREAD_ID --turn-limit 3 --format jsonl` is useful when a slightly larger recent window, still bounded, is needed instead of a single turn.

## Standard recovery loop

1. Check the installation without reading conversation data:

   ```bash
   t3-session doctor --format json
   ```

2. Retrieve the exact thread using the normalized projection:

   ```bash
   t3-session get THREAD_ID --format json
   ```

3. Inspect `thread`, `turns`, `messages`, `activities`, `provider`, and `warnings` together. Preserve null values and warnings.

4. If another tool needs streaming records, use:

   ```bash
   t3-session get THREAD_ID --format jsonl
   ```

5. Use provider events only for a targeted gap:

   ```bash
   t3-session get THREAD_ID --raw-jsonl
   ```

   Valid records remain available when individual provider lines are malformed. A nonzero exit code and stderr warning must be reported rather than hidden.

## Missing database or schema

Run doctor first. If the database is unavailable or required projection tables are missing, report the resolved condition. Do not search browser profiles, IndexedDB, LevelDB, full-disk paths, cloud APIs, or unrelated logs. The CLI intentionally fails clearly instead of guessing.

## Missing thread

A missing exact ID is not a title-search result. Use title search only when the task provides a title:

```bash
t3-session find --title "sanitized topic" --format json
```

Confirm the returned ID before retrieving it. Deleted threads are excluded from title search and exact retrieval.

## Empty list page

An empty `threads` array from `list` can mean the offset ran past the end of the result set, or that `--since`/`--before` excluded threads with a null `updated_at` (a null timestamp cannot satisfy either bound). Check `count`, `hasMore`, `limit`, and `offset` in the response before concluding there is no match. Retry with a smaller `--offset`, a wider `--since`/`--before` window, or without `--since`/`--before` entirely.

## Project filter matches nothing

`--project` is an exact, case-insensitive match on the trimmed project title, not a substring search. If it returns nothing, retry `t3-session list` without `--project` and inspect the `project.title` values in the results, or use `t3-session find --title "..."` for substring matching against thread titles.

## Active or partially persisted thread

The SQLite projection can lag a turn that is still in progress. Every `get` result carries a `liveState` object; check `liveState.complete` before summarizing a thread, and report the projection's contents honestly — including any `state` on the newest turn, `liveState.reasons`, and any `warnings`. Do not present an in-flight turn as finished just because it appears in the output.

```bash
t3-session get THREAD_ID --format json
```

If `liveState.complete` is `false`, follow with a bounded tail rather than re-polling `get` by hand:

```bash
t3-session tail THREAD_ID --once --format jsonl
t3-session tail THREAD_ID --max-cycles 5 --turn-limit 2 --format jsonl
```

`tail --once` answers "what does the thread look like right now, including anything that changed since I last checked." A bounded `--max-cycles` or `--timeout` tail follows the thread for a limited window inside an automated workflow; never start an unbounded tail (no `--once`, `--max-cycles`, or `--timeout`) outside an interactive session where a human can interrupt it. Treat every `upsert` record as replace-by-identifier, not append, and rely on the chronological order within each cycle instead of re-sorting.

### A thread that never becomes complete

`liveState.reasons` explains why `complete` is `false`: `"turn-not-terminal"` means the latest turn's state is not one of the known terminal states (an unrecognized turn state is deliberately treated as non-terminal, since guessing that an unfamiliar state means "finished" is the more damaging error); `"streaming-message"` means at least one message row is still marked streaming; `"provider-active"` means the provider session status itself is an active-looking value. If a thread stays incomplete across repeated checks, report it as still active and describe which reasons are present — do not wait indefinitely for `complete` to become `true`, and do not infer completion from elapsed time.

### A tail that emits nothing

Cycle 1 of a tail always emits a full baseline (a `thread` record, every existing turn/message/activity record, and a `live-state` record). If later cycles emit no data records, that means nothing changed in the projection — it does not mean the tail is broken. To get a definite, one-shot answer instead of waiting on a live interval, use `--once` or a small `--max-cycles`:

```bash
t3-session tail THREAD_ID --once --format jsonl
```

### A busy or locked database during a tail

A busy or locked SQLite database on one poll cycle does not kill the tail; it is retried on the next cycle, up to three consecutive failures, with a machine-readable diagnostic written to stderr on each attempt while stdout stays clean. The fourth consecutive failure exits 4. Report the failure and the stderr diagnostics rather than looping the CLI manually to retry — the tail already retries within its own bounds, and a fourth failure is a real condition to surface, not something to paper over.

## Partial provider history

A raw provider file can contain valid records, empty lines, unsupported labels, or malformed JSON. Keep valid record order, include the warning details, and state that the raw stream is partial. Do not treat token usage or delta events as a replacement for projected messages when the SQLite projection is available.

## Output discipline

- Keep JSON and JSONL stdout clean for machine consumers.
- Treat stderr as diagnostics, not conversation content.
- Never print credentials, tokens, private prompts, or unrelated local paths.
- Never write to the T3 home, SQLite database, WAL/SHM files, or provider logs.
- Use a temporary fixture home and an explicit `--db` path when developing or testing.
