# t3-session CLI Reference

Assume the package is installed and the current task provides a sanitized thread ID.

## Configuration

```bash
t3-session --home <t3-home> get <thread-id>
T3_HOME=<t3-home> t3-session get <thread-id>
t3-session --db <state-db> get <thread-id>
```

Resolution order is `--home`, `T3_HOME`, then the default T3 home. `--db` overrides the derived SQLite path and is useful for isolated fixtures.

## Retrieve a thread

```bash
t3-session get <thread-id>
t3-session get <thread-id> --format json
t3-session get <thread-id> --format jsonl
t3-session get <thread-id> --raw-jsonl
```

The default format shows thread metadata, provider metadata, turns, messages, activities, and warnings. JSON emits the complete `t3-session.thread.v1` object. Normalized JSONL emits `thread`, `turn`, `message`, and `activity` records using `t3-session.jsonl-record.v1`.

`--raw-jsonl` emits parsed provider records one per line. A malformed provider line is reported on stderr and does not discard valid records.

## Search and diagnose

```bash
t3-session find --title "topic"
t3-session find --title "topic" --format json
t3-session doctor
t3-session doctor --format json
```

Title search is trimmed, case-insensitive, parameterized, excludes deleted threads, and does not search message content. Doctor reports the resolved home, database readability, schema health, counts, WAL presence, provider-log directory, runtime, and package version.

## Schemas

```bash
t3-session schema thread.v1
t3-session schema error.v1
t3-session schema jsonl-record.v1
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
