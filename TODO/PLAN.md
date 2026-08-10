# t3-session Implementation Plan

## 1. Goal

Build a small, local-only Node.js npm package and CLI that retrieves T3 Code conversation threads by thread ID, with a stable normalized output format suitable for both humans and agents.

Primary recovery use case:

```text
Given a T3 thread ID, retrieve the complete persisted conversation and its supporting activity without searching arbitrary storage formats.
```

Initial verified storage locations:

```text
$T3_HOME/userdata/state.sqlite
$T3_HOME/userdata/logs/provider/events.<threadId>.log
```

Default:

```text
T3_HOME=~/.t3
```

The SQLite projection is the primary source. The provider log is an optional raw/event-stream source.

## 2. Non-goals for the first release

Do not implement broad storage discovery or scan arbitrary locations.

Specifically out of scope for the MVP:

- Browser profile scanning
- IndexedDB or LevelDB scanning
- Full-disk searching
- Cloud or relay API access
- Writing to T3 storage
- Automatic session resumption
- Embeddings or semantic search
- AI summarization
- A general adapter/plugin marketplace
- A complex query language
- Full support for every historical T3 database schema

The tool should fail clearly when the expected SQLite schema is absent rather than silently searching unrelated storage.

## 3. Package and runtime

Recommended package:

```text
@albro3459/t3-session
```

CLI executable:

```text
t3-session
```

Use plain ESM JavaScript to match `~/GitHub/br0wser`.

Package conventions:

- `type: module`
- Node.js `bin` entry
- Node.js built-in modules where practical
- No shelling out to the system `sqlite3` executable
- Read-only database access
- Explicit `T3_HOME` and `--home` support
- Target Node.js 22.16+ if using the built-in SQLite API; confirm the API during implementation
- Avoid native SQLite dependencies unless the built-in API proves insufficient

The release package should include the CLI, schemas, skill files, README, license, and notice files.

## 4. Repository layout

Start with a structure similar to `br0wser`, splitting implementation into `src/` once the CLI is more than a small wrapper.

```text
package.json
README.md
LICENSE
NOTICE.txt
scripts/
  t3-session.js
src/
  cli.js
  config.js
  errors.js
  normalize.js
  output.js
  sqlite-store.js
  provider-jsonl.js
  skill-install.js
schemas/
  thread.v1.json
  error.v1.json
  jsonl-record.v1.json
skills/
  t3-session/
    SKILL.md
    references/
      cli.md
      workflows.md
    agents/
      openai.yaml
TODO/
  PLAN.md
```

The executable should be a thin wrapper around reusable library functions.

## 5. Public Node API

Expose a small API from the package in addition to the CLI:

```js
import { createT3SessionClient } from "@albro3459/t3-session";

const client = await createT3SessionClient({
  home: process.env.T3_HOME
});

const thread = await client.getThread(threadId);
const matches = await client.findThreads({ title: "ownership records" });
```

Initial API:

```text
createT3SessionClient(options)
client.getThread(threadId, options)
client.findThreads(options)
client.readRawJsonl(threadId, options)
client.doctor(options)
```

The CLI and library must use the same normalized data structures.

## 6. Configuration

Resolution order:

1. `--home PATH`
2. `T3_HOME`
3. `~/.t3`

Derived paths:

```js
stateDb = path.join(home, "userdata", "state.sqlite");
providerLog = path.join(
  home,
  "userdata",
  "logs",
  "provider",
  `events.${threadId}.log`
);
```

Do not use recursive discovery for the MVP.

Support an optional `--db PATH` override for fixture testing and unusual installations, but keep `T3_HOME` as the normal user-facing configuration.

## 7. SQLite primary source

Open `state.sqlite` read-only and allow SQLite to use its associated WAL/SHM files.

Expected projection tables:

```text
projection_threads
projection_projects
projection_thread_messages
projection_thread_activities
projection_thread_sessions
projection_turns
```

`doctor` should verify the required tables before attempting retrieval.

### Thread metadata query

Use a parameterized query:

```sql
SELECT
  t.thread_id,
  t.project_id,
  t.title,
  t.branch,
  t.worktree_path,
  t.latest_turn_id,
  t.created_at,
  t.updated_at,
  t.latest_user_message_at,
  t.deleted_at,
  t.runtime_mode,
  t.interaction_mode,
  t.model_selection_json,
  p.title AS project_title,
  p.workspace_root
FROM projection_threads AS t
LEFT JOIN projection_projects AS p
  ON p.project_id = t.project_id
WHERE t.thread_id = ?
  AND t.deleted_at IS NULL;
```

### Messages query

```sql
SELECT
  message_id,
  thread_id,
  turn_id,
  role,
  text,
  is_streaming,
  created_at,
  updated_at,
  attachments_json
FROM projection_thread_messages
WHERE thread_id = ?
ORDER BY created_at, message_id;
```

### Activities query

```sql
SELECT
  activity_id,
  thread_id,
  turn_id,
  tone,
  kind,
  summary,
  payload_json,
  created_at,
  sequence
FROM projection_thread_activities
WHERE thread_id = ?
ORDER BY created_at, activity_id;
```

### Turns and provider metadata

Retrieve turns from `projection_turns` ordered by `row_id`.

Retrieve provider metadata from `projection_thread_sessions`, including:

- `provider_name`
- `provider_session_id`
- `provider_thread_id`
- `provider_instance_id`
- `status`
- `last_error`

The provider IDs may be null in the projection. Do not treat that as a retrieval failure; the raw provider JSONL can contain the mapping.

## 8. Provider JSONL source

Support the exact provider log path as an optional fallback/raw mode:

```text
$T3_HOME/userdata/logs/provider/events.<threadId>.log
```

Although the file uses a `.log` extension and prefixes each line, it contains line-oriented JSON records such as:

```text
[time] CANON: {...}
[time] NTIVE: {...}
```

The parser should:

1. Remove the timestamp prefix.
2. Identify the record label (`CANON` or `NTIVE`).
3. Parse the remaining JSON.
4. Preserve the original record label and timestamp.
5. Emit parse warnings for malformed lines.
6. Never fail the normal SQLite retrieval solely because a raw provider line is malformed.

Use `jsonl` consistently in command names, flags, documentation, and output format names. Do not use `ndjson`.

Example:

```bash
t3-session get THREAD_ID --raw-jsonl > provider-events.jsonl
```

Raw JSONL should preserve provider stream events, tool calls, user events, assistant events, and token usage records. The normal `get` command should not reconstruct the conversation from token deltas when SQLite projections are available.

## 9. Normalized thread output

The canonical thread output should be versioned:

```json
{
  "schemaVersion": "t3-session.thread.v1",
  "toolVersion": "0.1.0",
  "thread": {},
  "turns": [],
  "messages": [],
  "activities": [],
  "provider": {},
  "warnings": []
}
```

Thread fields should include:

- `id`
- `projectId`
- `title`
- `project`
- `createdAt`
- `updatedAt`
- `latestTurnId`
- `runtimeMode`
- `interactionMode`
- `modelSelection`
- `workspaceRoot`

Messages should preserve:

- `messageId`
- `turnId`
- `role`
- `text`
- streaming state
- timestamps
- attachment metadata

Activities should preserve:

- activity ID
- turn ID
- tone
- kind
- summary
- parsed payload where valid
- timestamp

Unknown or malformed JSON fields should be retained in an adapter-specific field where useful, but normal output must remain stable.

## 10. CLI commands

### `get`

Retrieve one thread by exact ID.

```bash
t3-session get 8833580e-bef2-4ece-8fde-cbacbc58650f
t3-session get THREAD_ID --format json
t3-session get THREAD_ID --format jsonl
t3-session get THREAD_ID --raw-jsonl
```

Default human output should show metadata followed by messages and a compact activity section.

`--format json` should emit the complete `thread.v1` object.

`--format jsonl` should emit stable one-record-per-line output with record types such as:

```text
thread
turn
message
activity
```

`--raw-jsonl` should emit parsed raw provider events rather than the normalized projection records.

### `find`

Initially search only thread titles.

```bash
t3-session find --title "ownership records"
t3-session find --title "ownership records" --format json
```

Use a parameterized SQLite query:

```sql
SELECT
  t.thread_id,
  t.project_id,
  t.title,
  t.created_at,
  t.updated_at,
  p.title AS project_title
FROM projection_threads AS t
LEFT JOIN projection_projects AS p
  ON p.project_id = t.project_id
WHERE t.deleted_at IS NULL
  AND t.title COLLATE NOCASE LIKE '%' || trim(?) || '%'
ORDER BY t.updated_at DESC;
```

Add title escaping if the implementation treats `%` and `_` as literal search characters.

Do not search message content in the MVP.

### `doctor`

```bash
t3-session doctor
t3-session doctor --format json
```

Report:

- Resolved T3 home
- Database path
- Database readability
- WAL presence
- Required table presence
- Thread/message/activity counts
- Provider log directory presence
- Package/runtime version

### `schema`

```bash
t3-session schema thread.v1
```

Print the bundled JSON schema.

### `install`

Mirror `br0wser` for bundled skill installation:

```bash
t3-session install --skills claude
t3-session install --skills codex
```

The installer must verify the source skill exists and must not silently destroy an existing user-edited skill directory. Require an explicit overwrite option or make a backup before replacement.

## 11. Output and error behavior

Rules:

- Data goes to stdout.
- Diagnostics go to stderr.
- JSON output must never be mixed with progress messages.
- Human output may be formatted for readability.
- All SQL values must be parameterized.
- No shell commands are required for normal operation.

Suggested exit codes:

```text
0  success
1  unexpected failure
2  thread not found
3  invalid arguments/configuration
4  database/schema unavailable
5  raw JSONL partially unreadable
```

Machine-readable errors should have a stable shape:

```json
{
  "schemaVersion": "t3-session.error.v1",
  "code": "THREAD_NOT_FOUND",
  "message": "No thread matched the supplied ID.",
  "details": {
    "threadId": "..."
  }
}
```

## 12. Test plan

Use Node's built-in test runner (`node:test` and `node:assert`) unless a dependency becomes necessary. Tests must not access the user's real `~/.t3` by default.

Create temporary T3 homes and fixture databases for integration tests.

### Unit tests

1. **Configuration resolution**
   - `--home` overrides `T3_HOME`.
   - `T3_HOME` overrides the default home.
   - Derived SQLite and provider-log paths are correct.
   - `--db` overrides the derived SQLite path.

2. **Thread ID validation**
   - Accept valid UUID-style IDs.
   - Reject empty IDs.
   - Reject path traversal attempts.
   - Ensure the provider-log path cannot escape the provider log directory.

3. **Normalization**
   - Normalize SQLite rows into `thread.v1`.
   - Preserve null values and empty arrays consistently.
   - Parse valid JSON fields such as `model_selection_json` and `attachments_json`.
   - Retain warnings for malformed JSON fields.

4. **JSONL parser**
   - Parse `CANON` lines.
   - Parse `NTIVE` lines.
   - Preserve timestamps and labels.
   - Reject or warn on malformed lines without crashing the whole stream.
   - Preserve record order.

5. **Title search**
   - Trim the search parameter.
   - Match case-insensitively.
   - Exclude deleted threads.
   - Sort by `updated_at` descending.
   - Use parameters rather than interpolated SQL.
   - Cover `%`, `_`, quotes, and SQL-injection-shaped input.

6. **Output formats**
   - Stable JSON shape.
   - Stable `jsonl` record types.
   - No diagnostic output on stdout.
   - Raw JSONL output preserves one record per line.

### SQLite integration tests

Create a fixture database containing:

- One project
- One active thread
- One deleted thread
- Multiple turns
- User and assistant messages
- Activities with valid and malformed payload JSON
- Provider session metadata
- A thread with no project row

Test:

- Exact thread retrieval.
- Project join.
- Message ordering.
- Activity ordering.
- Turn ordering.
- Deleted thread behavior.
- Missing required table behavior.
- Read-only behavior: retrieval must not alter the database.
- WAL-compatible opening where feasible.

### CLI integration tests

Run the executable against a temporary fixture home and verify:

```bash
t3-session get THREAD_ID --format json
t3-session get THREAD_ID --format jsonl
t3-session find --title "needle"
t3-session doctor --format json
t3-session get missing-id
```

Verify output and exit codes.

### Skill installer tests

Test:

- Skill source validation.
- Claude destination selection.
- Codex destination selection.
- Existing destination handling.
- No writes outside the selected skill directory.
- Explicit overwrite/backup behavior.

### Fixture and regression tests

Keep a sanitized fixture derived from the verified schema and a small provider JSONL fixture. Do not commit real conversation content, credentials, bearer tokens, raw paths, or private prompts.

Add a regression fixture for:

```text
8833580e-bef2-4ece-8fde-cbacbc58650f
```

using a sanitized ID and sanitized data, not the actual local transcript.

## 13. Manual verification checklist

Before release, verify against the real local installation without modifying it:

```bash
T3_HOME="$HOME/.t3" t3-session doctor --format json
T3_HOME="$HOME/.t3" t3-session get 8833580e-bef2-4ece-8fde-cbacbc58650f --format json
T3_HOME="$HOME/.t3" t3-session get 8833580e-bef2-4ece-8fde-cbacbc58650f --raw-jsonl
T3_HOME="$HOME/.t3" t3-session find --title "t3-session" --format json
```

Check that:

- The current thread resolves.
- Project metadata is present.
- Messages are complete and ordered.
- Activities are present.
- Raw JSONL is readable.
- The database modification time and contents are unchanged.
- No credentials are printed by default.

## 14. Documentation plan

README sections:

1. What the tool does.
2. Installation.
3. `T3_HOME` configuration.
4. Exact thread retrieval.
5. JSON and JSONL output.
6. Title search.
7. Raw provider JSONL.
8. Claude/Codex skill installation.
9. Privacy and read-only guarantees.
10. Schema/versioning policy.
11. Development and test commands.

Skill documentation should focus on the recovery workflow:

1. Get the thread ID.
2. Run `t3-session get <threadId>`.
3. Use JSON for agent processing.
4. Use raw JSONL only when projection data is insufficient.
5. Report missing or partial history honestly.

## 15. Implementation sequence

### Phase 1: package skeleton ✅

- [x] Add `package.json`.
- [x] Add executable entry point.
- [x] Add configuration and error modules.
- [x] Add `--help`, `--version`, and command dispatch.
- [x] Add test runner configuration/scripts.

### Phase 2: SQLite retrieval ✅

- [x] Implement read-only database opening.
- [x] Validate required tables.
- [x] Implement exact thread retrieval.
- [x] Implement project, message, activity, turn, and provider joins.
- [x] Implement normalized output.
- [x] Add SQLite fixtures and integration tests.

### Phase 3: CLI output ✅

- [x] Implement human output.
- [x] Implement `--format json`.
- [x] Implement `--format jsonl`.
- [x] Implement stable errors and exit codes.
- [x] Add CLI integration tests.

### Phase 4: title search and doctor ✅

- [x] Implement `find --title`.
- [x] Exclude deleted threads.
- [x] Implement `doctor`.
- [x] Add search and diagnostics tests.

### Phase 5: raw provider JSONL ✅

- [x] Implement exact provider-log path resolution.
- [x] Implement prefixed JSONL parsing.
- [x] Implement `--raw-jsonl`.
- [x] Add malformed-line and ordering tests.

### Phase 6: skill and packaging ✅

- [x] Add bundled skill files.
- [x] Implement explicit skill installation.
- [x] Add README and package metadata.
- [x] Add package file whitelist.
- [x] Add installation tests.

### Phase 7: verification and release preparation ✅

- [x] Run the complete test suite with `npm test` (42 tests passing).
- [x] Run configured static validation with `npm run check` (no separate lint script is configured).
- [x] Perform real local read-only verification against `/Users/alexbrodsky/.t3` using the verified thread ID; `state.sqlite` remained byte-for-byte and mtime unchanged, and the CLI returned normalized JSON, raw provider JSONL, and title-search results. Existing WAL/SHM locking state changed while the active local installation was being read.
- [x] Review package contents with `npm pack --dry-run` (version `0.1.0`, 24 files, and the declared package whitelist are consistent).
- [x] Confirm the first-release version remains `0.1.0` and document the installed-version check with `t3-session --version`.

## 16. Definition of done

The first release is complete when:

- `t3-session get <threadId>` retrieves a real T3 thread from `state.sqlite`.
- The supplied verified thread ID can be retrieved locally.
- The output includes thread metadata, project, turns, messages, activities, and provider metadata.
- `--format json` is stable and documented.
- `--format jsonl` is stable and documented.
- `--raw-jsonl` reads the exact provider event file without broad discovery.
- `find --title` works with trimmed, case-insensitive matching.
- `doctor` explains missing database/schema conditions.
- The CLI never mutates T3 storage.
- Tests cover configuration, SQL retrieval, output, errors, title search, JSONL parsing, and skill installation.
- No test depends on the real user's private transcript or credentials.
- The package can be installed globally and exposes `t3-session` on PATH.
