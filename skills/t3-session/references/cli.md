# t3-session CLI Reference

Assume the package is installed and the current task provides a sanitized thread ID.

## Configuration

```bash
t3-session --home <t3-home> get <thread-id>
T3_HOME=<t3-home> t3-session get <thread-id>
t3-session --db <state-db> get <thread-id>
```

Resolution order is `--home`, `T3_HOME`, then the default T3 home. `--db` overrides the derived SQLite path and is useful for isolated fixtures.

## List threads

```bash
t3-session list
t3-session list --project <text> --since <timestamp> --before <timestamp>
t3-session list --limit <n> --offset <n> --reverse
t3-session list --format human|json|jsonl
```

Options:

- `--project <text>` — match `projection_projects.title` case-insensitively; exact match on the trimmed title, not a substring search. Trimmed and rejected as invalid if empty.
- `--since <timestamp>` — inclusive lower bound on `updated_at`, ISO-8601.
- `--before <timestamp>` — exclusive upper bound on `updated_at`, ISO-8601. Adjacent `--since`/`--before` windows compose without overlap or double counting.
- `--limit <n>` — maximum threads returned; default 50; non-negative integer.
- `--offset <n>` — skip matching threads before applying `--limit`; default 0; non-negative integer.
- `--reverse` — newest-first instead of the default oldest-first.

Invalid timestamps, limits, offsets, or an empty project filter produce the existing machine-readable `t3-session.error.v1` error before SQLite is opened.

Ordering: sorted by `updated_at`, then by `thread_id` as a tie-breaker, in the same direction as `--reverse`. Threads with a null `updated_at` sort last in both directions and are excluded entirely when `--since` or `--before` is used, because a null timestamp cannot satisfy a bound. Deleted threads (`deleted_at IS NOT NULL`) are always excluded.

Output: `--format json` and `--format jsonl` emit the `t3-session.list.v1` envelope — `schemaVersion`, `toolVersion`, `filters` (`project`, `since`, `before`), `ordering` (`sortBy: "updatedAt"`, `direction`), `limit`, `offset`, `count`, `hasMore`, and `threads` (metadata-only summaries: `id`, `projectId`, `title`, `project`, `branch`, `worktreePath`, `createdAt`, `updatedAt`, `latestUserMessageAt`, `latestTurnId`). Listing output never contains message or activity text. `hasMore` indicates whether another page is available past `offset + limit`; page forward by increasing `--offset`.

## Retrieve a thread

```bash
t3-session get <thread-id>
t3-session get <thread-id> --format json
t3-session get <thread-id> --format jsonl
t3-session get <thread-id> --raw-jsonl
t3-session get <thread-id> --last-turn
t3-session get <thread-id> --turn <turn-id>
t3-session get <thread-id> --turn-limit <n> --turn-offset <n>
```

The default format shows thread metadata, provider metadata, turns, messages, activities, and warnings. JSON emits the complete `t3-session.thread.v1` object. Normalized JSONL emits `thread`, `turn`, `message`, and `activity` records using `t3-session.jsonl-record.v1`, in chronological order after the thread header — this is the default and only order for `get --format jsonl`; do not re-sort records.

`--raw-jsonl` emits parsed provider records one per line. A malformed provider line is reported on stderr and does not discard valid records.

### Bounded retrieval

- `--last-turn` — the newest turn and its associated records; shorthand for a one-turn newest-side window.
- `--turn <turn-id>` — one exact turn and its associated records.
- `--turn-limit <n>` — a bounded window of turns counted from the newest side; non-negative integer; defaults to 1 when only `--turn-offset` is given.
- `--turn-offset <n>` — skip turns from the newest side before applying `--turn-limit`; non-negative integer; default 0.

Mutually exclusive combinations, rejected with the machine-readable invalid-arguments error:

- `--turn` cannot be combined with `--last-turn`, `--turn-limit`, or `--turn-offset`.
- `--last-turn` cannot be combined with `--turn-limit` or `--turn-offset`.

Selection: turns are selected from the newest side, then always emitted in chronological order. For each selected turn, the window includes the turn row, activities whose `turn_id` matches, and messages reached through `pending_message_id`, `assistant_message_id`, or a matching `turn_id`. Projected user prompts are stored with a null `turn_id`, so they are only reachable through `pending_message_id` — this is why `--last-turn` still includes the user prompt that started the turn. Records reached through more than one association path are deduplicated by ID. An offset past the end, or a `--turn` ID that matches nothing, is a valid empty window: it returns a normalized thread with empty `turns`, `messages`, and `activities`, not a missing-thread error. Plain `get <thread-id>` with none of these options is unchanged and returns the full history.

Bounded output carries a `selection` object on the normalized thread: `kind` (`"turn"` or `"turn-window"`), `turnId`, `turnLimit`, `turnOffset`, `totalTurns`, `selectedTurnIds`. Full retrieval omits `selection` entirely — its presence is the machine-readable signal that output is partial. Human output for a bounded read adds a `Selection` block with `Partial history: yes` and renames the sections `Turns (partial)`, `Messages (partial)`, `Activities (partial)`.

## Search and diagnose

```bash
t3-session find --title "topic"
t3-session find --title "topic" --format json
t3-session find --title "topic" --reverse
t3-session doctor
t3-session doctor --format json
```

Title search is trimmed, case-insensitive, parameterized, excludes deleted threads, and does not search message content. `find` defaults to oldest-first chronological order and takes `--reverse` for newest-first, the same meaning `--reverse` has for `list`. Its result shape is a bare array and is unchanged; `list` is the envelope-based, paginated command. Doctor reports the resolved home, database readability, schema health, counts, WAL presence, provider-log directory, runtime, and package version.

## Schemas

```bash
t3-session schema thread.v1
t3-session schema error.v1
t3-session schema jsonl-record.v1
t3-session schema list.v1
```

Schema output is written to stdout and is suitable for redirecting into a fixture or validator.

## Install the bundled skill

The package includes a sanitized recovery skill bundle. Install it for one agent target:

```bash
t3-session install --skills claude
t3-session install --skills codex
```

Destinations are `~/.claude/skills/t3-session` for Claude and `$CODEX_HOME/skills/t3-session`, or `~/.codex/skills/t3-session` when `CODEX_HOME` is unset.

An existing destination is never silently removed. Choose one explicit replacement policy:

```bash
t3-session install --skills claude --overwrite
t3-session install --skills claude --backup
t3-session install --skills codex --backup
```

`--overwrite` replaces the existing directory. `--backup` moves it to a timestamped sibling backup before installing. The installer copies only the package's allowlisted skill files and rejects a missing or malformed source bundle.
