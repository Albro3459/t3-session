# t3-session Workflows

Assume the CLI is installed and the thread ID comes from the current task context. Keep examples sanitized and do not substitute arbitrary filesystem searches for the documented paths.

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

## Partial provider history

A raw provider file can contain valid records, empty lines, unsupported labels, or malformed JSON. Keep valid record order, include the warning details, and state that the raw stream is partial. Do not treat token usage or delta events as a replacement for projected messages when the SQLite projection is available.

## Output discipline

- Keep JSON and JSONL stdout clean for machine consumers.
- Treat stderr as diagnostics, not conversation content.
- Never print credentials, tokens, private prompts, or unrelated local paths.
- Never write to the T3 home, SQLite database, WAL/SHM files, or provider logs.
- Use a temporary fixture home and an explicit `--db` path when developing or testing.
