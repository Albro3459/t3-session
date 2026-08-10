---
name: "t3-session"
description: "Use when a T3 Code conversation thread must be recovered from the local read-only projection by exact thread ID, searched by title, diagnosed, or inspected through provider JSONL."
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

1. Obtain the exact T3 thread ID from the current task context.
2. Run `t3-session get <thread-id>` for readable metadata and conversation content.
3. Use `--format json` when an agent or script needs the complete `thread.v1` object.
4. Use `--format jsonl` when a consumer needs one stable normalized record per line.
5. Use `--raw-jsonl` only when projection data is insufficient; report warnings and partial records honestly.
6. Run `t3-session doctor --format json` when the database or expected projection schema is unavailable.

## Safe defaults

- Retrieval is read-only.
- The CLI uses `--home`, then `T3_HOME`, then the default T3 home.
- No recursive discovery or broad filesystem search is performed.
- Diagnostics are written to stderr for commands whose primary output is data.
- Do not print credentials, bearer tokens, private prompts, or unrelated files.

## Examples

```bash
t3-session get THREAD_ID
t3-session get THREAD_ID --format json
t3-session get THREAD_ID --format jsonl
t3-session get THREAD_ID --raw-jsonl
t3-session find --title "project topic" --format json
t3-session doctor --format json
```

If history is missing, malformed, or only partially available, preserve the CLI warning or error and say what was unavailable. Do not reconstruct a complete conversation from token deltas when a normalized SQLite projection is present.

## References

- CLI options and output contracts: `references/cli.md`
- Practical recovery and troubleshooting flows: `references/workflows.md`
