import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createT3SessionClient,
  DatabaseUnavailableError,
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
