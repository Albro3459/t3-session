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

The SQLite projection can lag a turn that is still in progress. Report exactly what the projection currently contains — including any `state` on the newest turn and any `warnings` — and do not promise that the output reflects the live, in-progress state of the conversation. Live tailing of an active thread is a future increment and is not available in this CLI; do not describe it as available or imply that this tool can watch a thread update in real time.

## Partial provider history

A raw provider file can contain valid records, empty lines, unsupported labels, or malformed JSON. Keep valid record order, include the warning details, and state that the raw stream is partial. Do not treat token usage or delta events as a replacement for projected messages when the SQLite projection is available.

## Output discipline

- Keep JSON and JSONL stdout clean for machine consumers.
- Treat stderr as diagnostics, not conversation content.
- Never print credentials, tokens, private prompts, or unrelated local paths.
- Never write to the T3 home, SQLite database, WAL/SHM files, or provider logs.
- Use a temporary fixture home and an explicit `--db` path when developing or testing.
