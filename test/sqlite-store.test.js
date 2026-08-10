import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createT3SessionClient,
  DatabaseUnavailableError,
  InvalidArgumentsError,
  SchemaUnavailableError,
  ThreadNotFoundError,
} from "../src/index.js";
import {
  ACTIVE_THREAD_ID,
  DELETED_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  ORPHAN_THREAD_ID,
  createFixtureDatabase,
} from "./fixtures/sqlite-fixture.js";

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test("retrieves and normalizes a complete thread from SQLite", async () => {
  const fixture = createFixtureDatabase();
  try {
    const before = fs.statSync(fixture.databasePath);
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);

    assert.equal(thread.schemaVersion, "t3-session.thread.v1");
    assert.equal(thread.toolVersion, "0.1.0");
    assert.deepEqual(thread.thread.project, {
      title: "Sanitized project",
      workspaceRoot: "/tmp/sanitized-workspace",
    });
    assert.equal(thread.thread.modelSelection.provider, "sanitized-model");
    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["turn-2", "turn-1"]);
    assert.deepEqual(thread.messages.map((message) => message.messageId), ["message-1", "message-2"]);
    assert.deepEqual(thread.activities.map((activity) => activity.activityId), ["activity-1", "activity-2"]);
    assert.equal(thread.provider.providerName, "SanitizedProvider");
    assert.equal(thread.provider.providerInstanceId, "instance-1");
    assert.equal(thread.warnings.length, 2);
    assert.equal(thread.messages[0].attachments[0].name, "safe.txt");
    assert.equal(thread.messages[1].attachments, null);
    assert.equal(thread.activities[1].payload.tool, "safe");
    assert.equal(thread.activities[0].payload, null);

    const after = fs.statSync(fixture.databasePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    cleanupFixture(fixture);
  }
});

test("preserves null project and provider metadata", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(ORPHAN_THREAD_ID);

    assert.equal(thread.thread.projectId, "missing-project");
    assert.equal(thread.thread.project, null);
    assert.equal(thread.thread.workspaceRoot, null);
    assert.deepEqual(thread.provider, {
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      providerInstanceId: null,
      status: null,
      lastError: null,
      activeTurnId: null,
      runtimeMode: null,
      updatedAt: null,
    });
    assert.deepEqual(thread.turns, []);
    assert.deepEqual(thread.messages, []);
    assert.deepEqual(thread.activities, []);
    assert.deepEqual(thread.warnings, []);
  } finally {
    cleanupFixture(fixture);
  }
});

test("uses the project join marker when project fields are null", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(NULL_FIELD_PROJECT_THREAD_ID);

    assert.deepEqual(thread.thread.project, {
      title: null,
      workspaceRoot: null,
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("treats deleted and missing threads as not found", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    await assert.rejects(
      client.getThread(DELETED_THREAD_ID),
      (error) => error instanceof ThreadNotFoundError && error.code === "THREAD_NOT_FOUND",
    );
    await assert.rejects(
      client.getThread("missing-thread-0001"),
      (error) => error instanceof ThreadNotFoundError && error.details.threadId === "missing-thread-0001",
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("distinguishes an unavailable schema from a missing thread", async () => {
  const fixture = createFixtureDatabase();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("DROP TABLE projection_turns");
  database.exec("ALTER TABLE projection_projects DROP COLUMN workspace_root");
  database.close();

  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    await assert.rejects(
      client.getThread(ACTIVE_THREAD_ID),
      (error) => error instanceof SchemaUnavailableError
        && error.code === "SCHEMA_UNAVAILABLE"
        && error.details.missingTables.includes("projection_turns")
        && error.details.missingColumns.projection_projects.includes("workspace_root"),
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("reports an unavailable database separately", async () => {
  const client = await createT3SessionClient({ db: "/tmp/t3-session-does-not-exist/state.sqlite" });
  await assert.rejects(
    client.getThread(ACTIVE_THREAD_ID),
    (error) => error instanceof DatabaseUnavailableError && error.code === "DATABASE_UNAVAILABLE",
  );
});

test("finds active titles with normalized results and literal wildcard matching", async () => {
  const fixture = createFixtureDatabase();
  try {
    const database = new DatabaseSync(fixture.databasePath);
    const insert = database.prepare(`
      INSERT INTO projection_threads (
        thread_id, project_id, title, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "percent-thread-0001",
      "project-1",
      "100% coverage",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:04:00.000Z",
      null,
    );
    insert.run(
      "underscore-thread-0001",
      "project-1",
      "under_score",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:03:00.000Z",
      null,
    );
    insert.run(
      "quote-thread-0001",
      "project-1",
      "O'Reilly records",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:02:00.000Z",
      null,
    );
    insert.run(
      "sql-shaped-thread-0001",
      "project-1",
      "x' OR 1=1 --",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:01:00.000Z",
      null,
    );
    insert.run(
      "deleted-percent-thread-0001",
      "project-1",
      "100% coverage deleted",
      "2026-01-04T00:00:00.000Z",
      "2026-01-04T00:05:00.000Z",
      "2026-01-04T00:06:00.000Z",
    );
    database.close();

    const client = await createT3SessionClient({ db: fixture.databasePath });
    const percentMatches = await client.findThreads({ title: "  100%  " });
    assert.deepEqual(percentMatches.map((match) => match.id), ["percent-thread-0001"]);
    assert.deepEqual(percentMatches[0].project, {
      title: "Sanitized project",
      workspaceRoot: "/tmp/sanitized-workspace",
    });

    const underscoreMatches = await client.findThreads({ title: "UNDER_SCORE" });
    assert.deepEqual(underscoreMatches.map((match) => match.id), ["underscore-thread-0001"]);

    const quoteMatches = await client.findThreads({ title: "o'reilly" });
    assert.deepEqual(quoteMatches.map((match) => match.id), ["quote-thread-0001"]);

    const sqlMatches = await client.findThreads({ title: "' OR 1=1 --" });
    assert.deepEqual(sqlMatches.map((match) => match.id), ["sql-shaped-thread-0001"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("returns a read-only doctor report with schema and counts", async () => {
  const fixture = createFixtureDatabase();
  const home = path.join(fixture.directory, "home");
  fs.mkdirSync(path.join(home, "userdata", "logs", "provider"), { recursive: true });
  try {
    const client = await createT3SessionClient({ home, db: fixture.databasePath });
    const report = await client.doctor();

    assert.equal(report.schemaVersion, "t3-session.doctor.v1");
    assert.equal(report.resolvedHome, home);
    assert.equal(report.databasePath, fixture.databasePath);
    assert.equal(report.databaseReadable, true);
    assert.equal(report.walPresent, false);
    assert.equal(report.schemaValid, true);
    assert.deepEqual(report.counts, { threads: 4, messages: 2, activities: 2 });
    assert.equal(report.providerLogDirectoryPresent, true);
    assert.equal(report.healthy, true);
    assert.match(report.runtimeVersion, /^v\d+/);

    const alternateHome = path.join(fixture.directory, "alternate-home");
    const overridden = await client.doctor({ home: alternateHome, db: fixture.databasePath });
    assert.equal(overridden.resolvedHome, alternateHome);
  } finally {
    cleanupFixture(fixture);
  }
});

test("validates and trims public title-search input before opening SQLite", async () => {
  const client = await createT3SessionClient({ db: "/tmp/t3-session-search-input.sqlite" });

  await assert.rejects(
    client.findThreads({ title: "   " }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "title",
  );
  await assert.rejects(
    client.findThreads(),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "title",
  );
});

test("reports missing required columns in doctor diagnostics", async () => {
  const fixture = createFixtureDatabase();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("ALTER TABLE projection_projects DROP COLUMN workspace_root");
  database.close();

  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const report = await client.doctor();

    assert.equal(report.databaseReadable, true);
    assert.equal(report.schemaValid, false);
    assert.deepEqual(report.schema.missingColumns.projection_projects, ["workspace_root"]);
    assert.equal(report.counts, null);
    assert.equal(report.healthy, false);
  } finally {
    cleanupFixture(fixture);
  }
});
