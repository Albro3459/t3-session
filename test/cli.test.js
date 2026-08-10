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
      "message",
      "activity",
      "activity",
    ]);
    assert.ok(records.every((record) => record.schemaVersion === "t3-session.jsonl-record.v1"));
    assert.ok(records.every((record) => record.threadId === ACTIVE_THREAD_ID));
    assert.equal(records[0].data.title, "Sanitized recovery thread");
    assert.equal(records[0].provider.providerName, "SanitizedProvider");
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
    assert.deepEqual(report.counts, { threads: 4, messages: 2, activities: 2 });
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
