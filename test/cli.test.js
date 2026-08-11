import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseCliArgs } from "../src/cli.js";
import {
  ACTIVE_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  NULL_UPDATED_THREAD_ID,
  ORPHAN_THREAD_ID,
  TIE_THREAD_A_ID,
  TIE_THREAD_B_ID,
  WINDOW_THREAD_ID,
  createFixtureDatabase,
} from "./fixtures/sqlite-fixture.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(projectRoot, "scripts", "t3-session.js");

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

function runCli(fixture, args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      T3_HOME: path.join(fixture.directory, "home"),
    },
    encoding: "utf8",
  });
}

function writeProviderLog(fixture, content, threadId = ACTIVE_THREAD_ID) {
  const directory = path.join(fixture.directory, "home", "userdata", "logs", "provider");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `events.${threadId}.log`);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function parseError(result) {
  assert.equal(result.stdout, "");
  assert.notEqual(result.stderr, "");
  return JSON.parse(result.stderr);
}

test("parses get options before and after the command", () => {
  assert.deepEqual(parseCliArgs([
    "--db", "/tmp/state.sqlite",
    "get", ACTIVE_THREAD_ID,
    "--format", "jsonl",
    "--raw-jsonl",
  ]), {
    command: "get",
    args: [ACTIVE_THREAD_ID],
    home: undefined,
    db: "/tmp/state.sqlite",
    format: "jsonl",
    title: undefined,
    project: undefined,
    since: undefined,
    before: undefined,
    limit: undefined,
    offset: undefined,
    reverse: false,
    lastTurn: false,
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    rawJsonl: true,
    help: false,
    version: false,
  });
});

test("prints human-readable thread metadata, messages, and activities", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Sanitized recovery thread/);
    assert.match(result.stdout, /First sanitized question/);
    assert.match(result.stdout, /Second sanitized answer/);
    assert.match(result.stdout, /First activity/);
    assert.match(result.stdout, /Activities/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("emits complete thread.v1 JSON without diagnostics on stdout", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "--db",
      fixture.databasePath,
      "get",
      ACTIVE_THREAD_ID,
      "--format",
      "json",
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.schemaVersion, "t3-session.thread.v1");
    assert.equal(thread.thread.id, ACTIVE_THREAD_ID);
    assert.equal(thread.turns.length, 2);
    assert.equal(thread.messages.length, 2);
    assert.equal(thread.activities.length, 2);
    assert.equal(thread.provider.providerName, "SanitizedProvider");
    assert.equal(thread.warnings.length, 2);
  } finally {
    cleanupFixture(fixture);
  }
});

test("emits stable one-record-per-line normalized JSONL", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--format",
      "jsonl",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.recordType), [
      "thread",
      "turn",
      "turn",
      "message",
      "activity",
      "message",
      "activity",
    ]);
    assert.ok(records.every((record) => record.schemaVersion === "t3-session.jsonl-record.v1"));
    assert.ok(records.every((record) => record.threadId === ACTIVE_THREAD_ID));
    assert.equal(records[0].data.title, "Sanitized recovery thread");
    assert.equal(records[0].provider.providerName, "SanitizedProvider");

    // turn-1, turn-2, message-1, and activity-1 all share the 00:01:00.000Z
    // timestamp; ties break by type rank (turn, message, activity).
    const idsAfterHeader = records.slice(1).map((record) => (
      record.recordType === "turn" ? record.data.turnId
        : record.recordType === "message" ? record.data.messageId
          : record.data.activityId
    ));
    assert.deepEqual(idsAfterHeader, [
      "turn-1",
      "turn-2",
      "message-1",
      "activity-1",
      "message-2",
      "activity-2",
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports missing threads as a machine-readable error with exit code 2", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      "missing-thread-0001",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 2);
    assert.deepEqual(parseError(result), {
      schemaVersion: "t3-session.error.v1",
      code: "THREAD_NOT_FOUND",
      message: "No thread matched the supplied ID.",
      details: { threadId: "missing-thread-0001" },
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports unavailable databases and schemas with exit code 4", () => {
  const missingFixture = createFixtureDatabase();
  try {
    const missingResult = runCli(missingFixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--db",
      path.join(missingFixture.directory, "missing.sqlite"),
      "--format",
      "json",
    ]);
    assert.equal(missingResult.status, 4);
    assert.equal(parseError(missingResult).code, "DATABASE_UNAVAILABLE");
  } finally {
    cleanupFixture(missingFixture);
  }

  const schemaFixture = createFixtureDatabase();
  try {
    const database = new DatabaseSync(schemaFixture.databasePath);
    database.exec("DROP TABLE projection_turns");
    database.close();

    const result = runCli(schemaFixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--db",
      schemaFixture.databasePath,
      "--format",
      "json",
    ]);
    const error = parseError(result);
    assert.equal(result.status, 4);
    assert.equal(error.code, "SCHEMA_UNAVAILABLE");
    assert.ok(error.details.missingTables.includes("projection_turns"));
  } finally {
    cleanupFixture(schemaFixture);
  }
});

test("rejects invalid get arguments and emits raw provider JSONL records", () => {
  const fixture = createFixtureDatabase();
  try {
    const invalidResult = runCli(fixture, [
      "get",
      "--format",
      "xml",
      ACTIVE_THREAD_ID,
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(invalidResult.status, 3);
    assert.equal(parseError(invalidResult).code, "INVALID_ARGUMENTS");

    writeProviderLog(fixture, [
      "[2026-08-10T10:00:00.000Z] CANON: {\"event\":\"first\"}",
      "[2026-08-10T10:00:01.000Z] NTIVE: {\"event\":\"second\"}",
      "",
    ].join("\n"));
    const rawResult = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--raw-jsonl",
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(rawResult.status, 0);
    assert.equal(rawResult.stderr, "");
    assert.deepEqual(rawResult.stdout.trimEnd().split("\n").map((line) => JSON.parse(line)), [
      {
        timestamp: "2026-08-10T10:00:00.000Z",
        label: "CANON",
        data: { event: "first" },
      },
      {
        timestamp: "2026-08-10T10:00:01.000Z",
        label: "NTIVE",
        data: { event: "second" },
      },
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("emits parsed raw records with exit code 5 when provider lines are malformed", () => {
  const fixture = createFixtureDatabase();
  try {
    writeProviderLog(fixture, [
      "[first] CANON: {\"value\":1}",
      "malformed provider line",
      "[second] NTIVE: {\"value\":2}",
    ].join("\n"));
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--raw-jsonl",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 5);
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.data.value), [1, 2]);
    const diagnostic = JSON.parse(result.stderr);
    assert.equal(diagnostic.code, "RAW_JSONL_PARTIALLY_UNREADABLE");
    assert.equal(diagnostic.details.threadId, ACTIVE_THREAD_ID);
    assert.equal(diagnostic.details.warnings.length, 1);
    assert.equal(diagnostic.details.warnings[0].line, 2);

    const normalResult = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--format",
      "json",
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(normalResult.status, 0);
    assert.equal(normalResult.stderr, "");
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports missing provider logs distinctly without writing diagnostics to stdout", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--raw-jsonl",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 4);
    assert.equal(result.stdout, "");
    const diagnostic = parseError(result);
    assert.equal(diagnostic.code, "PROVIDER_LOG_MISSING");
    assert.equal(diagnostic.details.reason, "missing");
  } finally {
    cleanupFixture(fixture);
  }
});

test("finds titles through the CLI with JSON output and no diagnostics", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "find",
      "--title",
      "  SANITIZED RECOVERY  ",
      "--format",
      "json",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const matches = JSON.parse(result.stdout);
    assert.deepEqual(matches.map((match) => match.id), [ACTIVE_THREAD_ID]);
    assert.equal(matches[0].title, "Sanitized recovery thread");
    assert.equal(matches[0].project.title, "Sanitized project");
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor emits machine-readable diagnostics on stdout and uses health exit codes", () => {
  const fixture = createFixtureDatabase();
  const home = path.join(fixture.directory, "home");
  fs.mkdirSync(path.join(home, "userdata", "logs", "provider"), { recursive: true });
  try {
    const healthyResult = runCli(fixture, [
      "doctor",
      "--format",
      "json",
      "--db",
      fixture.databasePath,
    ]);

    assert.equal(healthyResult.status, 0);
    assert.equal(healthyResult.stderr, "");
    const report = JSON.parse(healthyResult.stdout);
    assert.equal(report.schemaVersion, "t3-session.doctor.v1");
    assert.equal(report.databaseReadable, true);
    assert.equal(report.schemaValid, true);
    assert.deepEqual(report.counts, { threads: 9, messages: 8, activities: 6 });
    assert.equal(report.providerLogDirectoryPresent, true);

    const missingResult = runCli(fixture, [
      "doctor",
      "--format",
      "json",
      "--db",
      path.join(fixture.directory, "missing.sqlite"),
    ]);
    assert.equal(missingResult.status, 4);
    assert.equal(missingResult.stderr, "");
    const missingReport = JSON.parse(missingResult.stdout);
    assert.equal(missingReport.databaseReadable, false);
    assert.equal(missingReport.schemaValid, false);
    assert.equal(missingReport.counts, null);
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor human output keeps diagnostics readable and off stderr", () => {
  const fixture = createFixtureDatabase();
  const home = path.join(fixture.directory, "home");
  fs.mkdirSync(path.join(home, "userdata", "logs", "provider"), { recursive: true });
  try {
    const result = runCli(fixture, ["doctor", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /T3 Session Doctor/);
    assert.match(result.stdout, /Database readable: yes/);
    assert.match(result.stdout, /Required columns/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("doctor human output labels dropped required tables as table missing", () => {
  const fixture = createFixtureDatabase();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    database.exec("DROP TABLE projection_turns");
    database.close();

    const result = runCli(fixture, ["doctor", "--db", fixture.databasePath]);

    assert.equal(result.status, 4);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /- projection_turns: missing/);
    assert.match(result.stdout, /- projection_turns: table missing/);
    assert.doesNotMatch(result.stdout, /projection_turns: present \(table missing\)/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("parses list options before and after the command", () => {
  assert.deepEqual(parseCliArgs([
    "--db", "/tmp/state.sqlite",
    "--reverse",
    "list",
    "--project", "CodeLaunch",
    "--since", "2026-01-01T00:00:00Z",
    "--before", "2026-02-01T00:00:00Z",
    "--limit", "10",
    "--offset", "5",
    "--format", "json",
  ]), {
    command: "list",
    args: [],
    home: undefined,
    db: "/tmp/state.sqlite",
    format: "json",
    title: undefined,
    project: "CodeLaunch",
    since: "2026-01-01T00:00:00Z",
    before: "2026-02-01T00:00:00Z",
    limit: "10",
    offset: "5",
    reverse: true,
    lastTurn: false,
    turn: undefined,
    turnLimit: undefined,
    turnOffset: undefined,
    rawJsonl: false,
    help: false,
    version: false,
  });
});

test("list --format json emits a t3-session.list.v1 envelope with metadata-only summaries", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["list", "--format", "json", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const list = JSON.parse(result.stdout);
    assert.equal(list.schemaVersion, "t3-session.list.v1");
    assert.equal(list.ordering.sortBy, "updatedAt");
    assert.equal(list.ordering.direction, "asc");
    assert.equal(list.count, 7);
    assert.equal(list.threads.length, 7);
    assert.equal(list.hasMore, false);
    for (const summary of list.threads) {
      assert.equal(Object.hasOwn(summary, "messages"), false);
      assert.equal(Object.hasOwn(summary, "activities"), false);
    }
    const serialized = JSON.stringify(list);
    assert.doesNotMatch(serialized, /First sanitized question/);
    assert.doesNotMatch(serialized, /Windowed question one/);
    assert.doesNotMatch(serialized, /First activity/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list --format jsonl emits a list header followed by one thread record per summary", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["list", "--format", "jsonl", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].recordType, "list");
    assert.equal(records[0].threadId, null);
    assert.equal(records[0].data.count, records.length - 1);
    assert.deepEqual(records.slice(1).map((record) => record.recordType), records.slice(1).map(() => "thread"));
  } finally {
    cleanupFixture(fixture);
  }
});

test("list human output is readable and contains the filter block", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["list", "--db", fixture.databasePath]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^Threads$/m);
    assert.match(result.stdout, /^Project: -$/m);
    assert.match(result.stdout, /^Since: -$/m);
    assert.match(result.stdout, /^Before: -$/m);
    assert.match(result.stdout, /^Order: updatedAt asc$/m);
    assert.match(result.stdout, /^Limit: 50$/m);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list --project trims input and matches case-insensitively", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "list", "--project", "  codelaunch  ", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const list = JSON.parse(result.stdout);
    assert.deepEqual(list.threads.map((thread) => thread.id), [
      WINDOW_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
      NULL_UPDATED_THREAD_ID,
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list --reverse paginates with limit and offset", () => {
  const fixture = createFixtureDatabase();
  try {
    const firstPage = runCli(fixture, [
      "list", "--reverse", "--limit", "2", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(firstPage.status, 0);
    assert.equal(firstPage.stderr, "");
    const firstList = JSON.parse(firstPage.stdout);
    assert.deepEqual(firstList.threads.map((thread) => thread.id), [TIE_THREAD_B_ID, TIE_THREAD_A_ID]);
    assert.equal(firstList.hasMore, true);

    const lastPage = runCli(fixture, [
      "list", "--reverse", "--limit", "2", "--offset", "6", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(lastPage.status, 0);
    assert.equal(lastPage.stderr, "");
    const lastList = JSON.parse(lastPage.stdout);
    assert.deepEqual(lastList.threads.map((thread) => thread.id), [NULL_UPDATED_THREAD_ID]);
    assert.equal(lastList.hasMore, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list filters by since (inclusive) and before (exclusive)", () => {
  const fixture = createFixtureDatabase();
  try {
    const sinceResult = runCli(fixture, [
      "list", "--since", "2026-02-01T00:00:00.000Z", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(sinceResult.status, 0);
    assert.equal(sinceResult.stderr, "");
    const sinceList = JSON.parse(sinceResult.stdout);
    assert.deepEqual(sinceList.threads.map((thread) => thread.id), [
      WINDOW_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
    ]);

    const beforeResult = runCli(fixture, [
      "list", "--before", "2026-02-02T00:00:00.000Z", "--format", "json", "--db", fixture.databasePath,
    ]);
    assert.equal(beforeResult.status, 0);
    assert.equal(beforeResult.stderr, "");
    const beforeList = JSON.parse(beforeResult.stdout);
    assert.deepEqual(beforeList.threads.map((thread) => thread.id), [
      ACTIVE_THREAD_ID,
      ORPHAN_THREAD_ID,
      NULL_FIELD_PROJECT_THREAD_ID,
      WINDOW_THREAD_ID,
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list rejects invalid values before opening SQLite", () => {
  const fixture = createFixtureDatabase();
  try {
    const badLimit = runCli(fixture, ["list", "--limit", "abc", "--db", fixture.databasePath]);
    assert.equal(badLimit.status, 3);
    assert.equal(parseError(badLimit).code, "INVALID_ARGUMENTS");

    const badSince = runCli(fixture, ["list", "--since", "not-a-date", "--db", fixture.databasePath]);
    assert.equal(badSince.status, 3);
    assert.equal(parseError(badSince).code, "INVALID_ARGUMENTS");

    const badProject = runCli(fixture, ["list", "--project", "   ", "--db", fixture.databasePath]);
    assert.equal(badProject.status, 3);
    assert.equal(parseError(badProject).code, "INVALID_ARGUMENTS");

    const badFormat = runCli(fixture, ["list", "--format", "xml", "--db", fixture.databasePath]);
    assert.equal(badFormat.status, 3);
    assert.equal(parseError(badFormat).code, "INVALID_ARGUMENTS");
  } finally {
    cleanupFixture(fixture);
  }
});

test("list rejects positional arguments, --title, and --raw-jsonl", () => {
  const fixture = createFixtureDatabase();
  try {
    const positional = runCli(fixture, ["list", "extra", "--db", fixture.databasePath]);
    assert.equal(positional.status, 3);
    assert.equal(parseError(positional).code, "INVALID_ARGUMENTS");

    const withTitle = runCli(fixture, ["list", "--title", "foo", "--db", fixture.databasePath]);
    assert.equal(withTitle.status, 3);
    assert.equal(parseError(withTitle).code, "INVALID_ARGUMENTS");

    const withRaw = runCli(fixture, ["list", "--raw-jsonl", "--db", fixture.databasePath]);
    assert.equal(withRaw.status, 3);
    assert.equal(parseError(withRaw).code, "INVALID_ARGUMENTS");
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --last-turn returns a bounded turn-window selection", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--last-turn", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.selection.kind, "turn-window");
    assert.deepEqual(thread.selection.selectedTurnIds, ["wturn-3"]);
    assert.equal(thread.selection.totalTurns, 3);
    assert.equal(thread.turns.length, 1);
    assert.deepEqual(thread.messages.map((message) => message.messageId), ["wuser-3", "wextra-3"]);
    assert.equal(thread.activities.length, 1);
    assert.equal(thread.activities[0].activityId, "wactivity-3");
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn selects one exact turn", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn", "wturn-1", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.equal(thread.selection.kind, "turn");
    assert.deepEqual(thread.selection.selectedTurnIds, ["wturn-1"]);
    assert.equal(thread.turns.length, 1);
    assert.equal(thread.turns[0].turnId, "wturn-1");
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn-limit emits only the selected window in chronological jsonl order", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn-limit", "2", "--format", "jsonl", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const records = result.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(records[0].recordType, "thread");
    const ids = records.slice(1).map((record) => (
      record.recordType === "turn" ? record.data.turnId
        : record.recordType === "message" ? record.data.messageId
          : record.data.activityId
    ));
    assert.deepEqual(ids, [
      "wturn-2", "wuser-2", "wactivity-2", "wassistant-2",
      "wturn-3", "wuser-3", "wactivity-3", "wextra-3",
    ]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("get --turn-limit with --turn-offset selects the correct window", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--turn-limit", "1", "--turn-offset", "1", "--format", "json", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const thread = JSON.parse(result.stdout);
    assert.deepEqual(thread.selection.selectedTurnIds, ["wturn-2"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("rejects mutually exclusive turn selection combinations with exit code 3", () => {
  const fixture = createFixtureDatabase();
  try {
    const combos = [
      ["get", WINDOW_THREAD_ID, "--turn", "wturn-1", "--last-turn"],
      ["get", WINDOW_THREAD_ID, "--turn", "wturn-1", "--turn-limit", "2"],
      ["get", WINDOW_THREAD_ID, "--last-turn", "--turn-limit", "2"],
      ["get", WINDOW_THREAD_ID, "--raw-jsonl", "--last-turn"],
    ];
    for (const args of combos) {
      const result = runCli(fixture, [...args, "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("rejects list-only options on get and turn options on find and list", () => {
  const fixture = createFixtureDatabase();
  try {
    for (const args of [
      ["get", ACTIVE_THREAD_ID, "--project", "x"],
      ["get", ACTIVE_THREAD_ID, "--since", "2026-01-01T00:00:00Z"],
      ["get", ACTIVE_THREAD_ID, "--before", "2026-01-01T00:00:00Z"],
      ["get", ACTIVE_THREAD_ID, "--limit", "1"],
      ["get", ACTIVE_THREAD_ID, "--offset", "1"],
      ["get", ACTIVE_THREAD_ID, "--reverse"],
      ["find", "--title", "Sanitized", "--last-turn"],
      ["find", "--title", "Sanitized", "--turn", "x"],
      ["find", "--title", "Sanitized", "--turn-limit", "2"],
      ["find", "--title", "Sanitized", "--turn-offset", "1"],
      ["list", "--last-turn"],
      ["list", "--turn", "x"],
      ["list", "--turn-limit", "2"],
      ["list", "--turn-offset", "1"],
    ]) {
      const result = runCli(fixture, [...args, "--db", fixture.databasePath]);
      assert.equal(result.status, 3, args.join(" "));
      assert.equal(parseError(result).code, "INVALID_ARGUMENTS", args.join(" "));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("bounded human get output marks partial history", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, [
      "get", WINDOW_THREAD_ID, "--last-turn", "--db", fixture.databasePath,
    ]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Partial history: yes/);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--help documents list, get turn-window, and find ordering options", () => {
  const fixture = createFixtureDatabase();
  try {
    const result = runCli(fixture, ["--help"]);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    for (const token of [
      "list",
      "--project",
      "--since",
      "--before",
      "--limit",
      "--offset",
      "--reverse",
      "--last-turn",
      "--turn",
      "--turn-limit",
      "--turn-offset",
    ]) {
      assert.ok(result.stdout.includes(token), `expected help to document ${token}`);
    }
  } finally {
    cleanupFixture(fixture);
  }
});
