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

test("rejects invalid get arguments and keeps deferred raw output off stdout", () => {
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

    const rawResult = runCli(fixture, [
      "get",
      ACTIVE_THREAD_ID,
      "--raw-jsonl",
      "--db",
      fixture.databasePath,
    ]);
    assert.equal(rawResult.status, 1);
    assert.equal(parseError(rawResult).code, "NOT_IMPLEMENTED");
  } finally {
    cleanupFixture(fixture);
  }
});
