# t3-session

`t3-session` is a small, read-only Node.js package and CLI for retrieving persisted T3 Code conversation threads by exact thread ID. It reads the documented SQLite projection and, on request, the exact provider JSONL event file. It does not scan arbitrary storage, call a cloud service, resume sessions, or write to T3 data.

## Requirements

- Node.js 22.16 or newer
- A local T3 home with the documented projection, when retrieving real data

## Installation

Install the public package globally:

```bash
npm install -g @albro3459/t3-session
```

Or run it without a global install:

```bash
npx @albro3459/t3-session --help
```

The package exposes the `t3-session` executable and a small ESM API. Verify the installed package version with:

```bash
t3-session --version
```

```js
import { createT3SessionClient } from "@albro3459/t3-session";

const client = await createT3SessionClient({ home: process.env.T3_HOME });
const thread = await client.getThread("THREAD_ID");
const matches = await client.findThreads({ title: "topic" });
```

## Configuration

The normal SQLite path is resolved in this order:

1. `--home PATH`
2. `T3_HOME`
3. the default user T3 home

The derived database is `<home>/userdata/state.sqlite`. Use `--db PATH` for an isolated fixture or unusual installation. The exact provider file is `<home>/userdata/logs/provider/events.<thread-id>.log`.

## Retrieve a thread

```bash
t3-session get THREAD_ID
t3-session get THREAD_ID --format json
t3-session get THREAD_ID --format jsonl
t3-session get THREAD_ID --raw-jsonl
```

The default output is human-readable metadata, provider information, turns, messages, activities, and warnings. `--format json` emits the complete `t3-session.thread.v1` object. `--format jsonl` emits stable normalized records with record types `thread`, `turn`, `message`, and `activity`. `--raw-jsonl` emits parsed provider events and preserves their labels and timestamps. Malformed provider lines are reported as warnings without discarding valid records.

## Search and diagnose

Title search is trimmed, case-insensitive, parameterized, excludes deleted threads, and does not search message content:

```bash
t3-session find --title "topic"
t3-session find --title "topic" --format json
```

Use doctor to inspect the expected installation without retrieving conversation content:

```bash
t3-session doctor
t3-session doctor --format json
```

Machine-readable data is written to stdout. Errors and raw JSONL partial-read diagnostics are written to stderr. The CLI uses stable exit codes and `t3-session.error.v1` errors.

## Bundled schemas

Print a schema for validation or integration work:

```bash
t3-session schema thread.v1
t3-session schema error.v1
t3-session schema jsonl-record.v1
```

The bundled schemas are versioned and are included in the npm package.

## Claude and Codex skill installation

The package includes a recovery skill at `skills/t3-session/`. Install it for Claude or Codex:

```bash
t3-session install --skills claude
t3-session install --skills codex
```

The destinations mirror the `br0wser` convention:

- Claude: `~/.claude/skills/t3-session`
- Codex: `$CODEX_HOME/skills/t3-session`, or `~/.codex/skills/t3-session` when `CODEX_HOME` is unset

The installer validates the packaged source and copies only the allowlisted bundle files. It never silently removes an existing destination. If the destination already exists, choose an explicit policy:

```bash
t3-session install --skills claude --overwrite
t3-session install --skills claude --backup
t3-session install --skills codex --backup
```

`--overwrite` replaces only the resolved `t3-session` skill directory. `--backup` moves the existing directory to a timestamped sibling backup before installing. The installer rejects invalid targets and does not accept a user-controlled destination path.

## Privacy and read-only guarantees

The package opens SQLite read-only, allows SQLite WAL/SHM files to be used, and never writes projection data to T3 storage. SQLite may update existing WAL/SHM locking state while a read is active. It does not perform recursive discovery or broad filesystem searches. Use `--db` and temporary fixture homes for development and tests. Do not paste credentials, bearer tokens, private prompts, or unrelated local data into reports.

## Schema and compatibility policy

The normalized output is versioned as `t3-session.thread.v1`. JSONL records are versioned as `t3-session.jsonl-record.v1`, and machine-readable errors as `t3-session.error.v1`. New fields may be added without changing existing field meanings; a breaking output change requires a new schema version. The public API and CLI commands remain stable across compatible releases.

## Development

Run syntax validation and the built-in test suite:

```bash
npm run check
npm test
```

Tests use temporary fixture databases and sanitized provider records. They do not access a real user T3 home or real Claude/Codex skill directories. Review the release file list with:

```bash
npm pack --dry-run
```
