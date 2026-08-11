import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  createT3SessionClient,
  DatabaseUnavailableError,
  InvalidArgumentsError,
  listThreadRowsFromDatabase,
  readThreadWindowFromDatabase,
  SchemaUnavailableError,
  ThreadNotFoundError,
} from "../src/index.js";
import {
  ACTIVE_THREAD_ID,
  DELETED_PROJECT_TWO_THREAD_ID,
  DELETED_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  NULL_UPDATED_THREAD_ID,
  ORPHAN_THREAD_ID,
  PROJECT_TWO_TITLE,
  TIE_THREAD_A_ID,
  TIE_THREAD_B_ID,
  WINDOW_THREAD_ID,
  createFixtureDatabase,
} from "./fixtures/sqlite-fixture.js";

// Chronological (oldest updated_at first) order of every non-deleted thread in the fixture.
// The null-updated thread sorts last in both directions per the documented ordering rule.
const CHRONOLOGICAL_THREAD_IDS = [
  ACTIVE_THREAD_ID,
  ORPHAN_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  WINDOW_THREAD_ID,
  TIE_THREAD_A_ID,
  TIE_THREAD_B_ID,
  NULL_UPDATED_THREAD_ID,
];
const REVERSE_CHRONOLOGICAL_THREAD_IDS = [
  TIE_THREAD_B_ID,
  TIE_THREAD_A_ID,
  WINDOW_THREAD_ID,
  NULL_FIELD_PROJECT_THREAD_ID,
  ORPHAN_THREAD_ID,
  ACTIVE_THREAD_ID,
  NULL_UPDATED_THREAD_ID,
];

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
    assert.deepEqual(report.counts, { threads: 9, messages: 8, activities: 6 });
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

test("list returns project/title/date metadata and no message or activity text", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {});
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), [
        "branch",
        "created_at",
        "latest_turn_id",
        "latest_user_message_at",
        "project_id",
        "project_join_id",
        "project_title",
        "thread_id",
        "title",
        "updated_at",
        "workspace_root",
        "worktree_path",
      ]);
      for (const forbiddenField of ["text", "summary", "payload_json", "payload", "attachments_json"]) {
        assert.equal(Object.hasOwn(row, forbiddenField), false);
      }
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("list defaults to oldest-first ordering across all non-deleted threads", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {});
    assert.deepEqual(rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS);
  } finally {
    cleanupFixture(fixture);
  }
});

test("list reverse: true returns newest-first ordering", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, { reverse: true });
    assert.deepEqual(rows.map((row) => row.thread_id), REVERSE_CHRONOLOGICAL_THREAD_IDS);
  } finally {
    cleanupFixture(fixture);
  }
});

test("equal updated_at values break ties by thread_id, direction-aware", async () => {
  const fixture = createFixtureDatabase();
  try {
    const forward = listThreadRowsFromDatabase(fixture.databasePath, {});
    const forwardTieIds = forward.rows
      .map((row) => row.thread_id)
      .filter((id) => id === TIE_THREAD_A_ID || id === TIE_THREAD_B_ID);
    assert.deepEqual(forwardTieIds, [TIE_THREAD_A_ID, TIE_THREAD_B_ID]);

    const reverse = listThreadRowsFromDatabase(fixture.databasePath, { reverse: true });
    const reverseTieIds = reverse.rows
      .map((row) => row.thread_id)
      .filter((id) => id === TIE_THREAD_A_ID || id === TIE_THREAD_B_ID);
    assert.deepEqual(reverseTieIds, [TIE_THREAD_B_ID, TIE_THREAD_A_ID]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a null updated_at sorts last in both forward and reverse order", async () => {
  const fixture = createFixtureDatabase();
  try {
    const forward = listThreadRowsFromDatabase(fixture.databasePath, {});
    assert.equal(forward.rows.at(-1).thread_id, NULL_UPDATED_THREAD_ID);

    const reverse = listThreadRowsFromDatabase(fixture.databasePath, { reverse: true });
    assert.equal(reverse.rows.at(-1).thread_id, NULL_UPDATED_THREAD_ID);
  } finally {
    cleanupFixture(fixture);
  }
});

test("project matching is case-insensitive and trimmed", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, { project: "  codelaunch  " });
    assert.deepEqual(rows.map((row) => row.thread_id).sort(), [
      NULL_UPDATED_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
      WINDOW_THREAD_ID,
    ].sort());
    assert.equal(rows.every((row) => row.project_title === PROJECT_TWO_TITLE), true);
    assert.equal(rows.some((row) => row.thread_id === DELETED_PROJECT_TWO_THREAD_ID), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("since is inclusive of the boundary timestamp", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {
      since: "2026-02-02T00:00:00.000Z",
    });
    assert.deepEqual(rows.map((row) => row.thread_id).sort(), [TIE_THREAD_A_ID, TIE_THREAD_B_ID].sort());
  } finally {
    cleanupFixture(fixture);
  }
});

test("before excludes the boundary timestamp", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {
      before: "2026-02-02T00:00:00.000Z",
    });
    assert.deepEqual(rows.map((row) => row.thread_id).sort(), [
      ACTIVE_THREAD_ID,
      ORPHAN_THREAD_ID,
      NULL_FIELD_PROJECT_THREAD_ID,
      WINDOW_THREAD_ID,
    ].sort());
  } finally {
    cleanupFixture(fixture);
  }
});

test("adjacent before/since windows partition non-null updated_at threads without overlap", async () => {
  const fixture = createFixtureDatabase();
  try {
    const olderWindow = listThreadRowsFromDatabase(fixture.databasePath, { before: "2026-02-01" });
    const newerWindow = listThreadRowsFromDatabase(fixture.databasePath, { since: "2026-02-01" });
    const olderIds = olderWindow.rows.map((row) => row.thread_id);
    const newerIds = newerWindow.rows.map((row) => row.thread_id);

    assert.equal(olderIds.some((id) => newerIds.includes(id)), false);
    assert.deepEqual(
      [...olderIds, ...newerIds].sort(),
      [
        ACTIVE_THREAD_ID,
        ORPHAN_THREAD_ID,
        NULL_FIELD_PROJECT_THREAD_ID,
        WINDOW_THREAD_ID,
        TIE_THREAD_A_ID,
        TIE_THREAD_B_ID,
      ].sort(),
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("list excludes deleted threads", async () => {
  const fixture = createFixtureDatabase();
  try {
    const { rows } = listThreadRowsFromDatabase(fixture.databasePath, {});
    const ids = rows.map((row) => row.thread_id);
    assert.equal(ids.includes(DELETED_THREAD_ID), false);
    assert.equal(ids.includes(DELETED_PROJECT_TWO_THREAD_ID), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("limit/offset paginate and hasMore reflects remaining rows", async () => {
  const fixture = createFixtureDatabase();
  try {
    const first = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 0 });
    assert.deepEqual(first.rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS.slice(0, 3));
    assert.equal(first.hasMore, true);

    const second = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 3 });
    assert.deepEqual(second.rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS.slice(3, 6));
    assert.equal(second.hasMore, true);

    const third = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 6 });
    assert.deepEqual(third.rows.map((row) => row.thread_id), CHRONOLOGICAL_THREAD_IDS.slice(6, 9));
    assert.equal(third.hasMore, false);

    const beyond = listThreadRowsFromDatabase(fixture.databasePath, { limit: 3, offset: 20 });
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.hasMore, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("invalid list arguments reject before the database is opened", async () => {
  const missingDatabasePath = "/tmp/t3-session-does-not-exist/state.sqlite";

  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { since: "not-a-date" }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "since",
  );
  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { limit: -1 }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "limit",
  );
  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { offset: "not-a-number" }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "offset",
  );
  assert.throws(
    () => listThreadRowsFromDatabase(missingDatabasePath, { project: "   " }),
    (error) => error instanceof InvalidArgumentsError && error.details.field === "project",
  );
});

test("listThreads raises DatabaseUnavailableError and SchemaUnavailableError", async () => {
  const client = await createT3SessionClient({ db: "/tmp/t3-session-list-missing/state.sqlite" });
  await assert.rejects(
    client.listThreads(),
    (error) => error instanceof DatabaseUnavailableError && error.code === "DATABASE_UNAVAILABLE",
  );

  const fixture = createFixtureDatabase();
  const database = new DatabaseSync(fixture.databasePath);
  database.exec("DROP TABLE projection_turns");
  database.close();

  try {
    const schemaClient = await createT3SessionClient({ db: fixture.databasePath });
    await assert.rejects(
      schemaClient.listThreads(),
      (error) => error instanceof SchemaUnavailableError && error.code === "SCHEMA_UNAVAILABLE",
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("getThread without a turn selection has no selection property", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);
    assert.equal(Object.hasOwn(thread, "selection"), false);
    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["turn-2", "turn-1"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ lastTurn: true } selects only the newest turn and its associated rows", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { lastTurn: true });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-3"]);
    assert.deepEqual(thread.messages.map((message) => message.messageId).sort(), ["wextra-3", "wuser-3"].sort());
    assert.deepEqual(thread.activities.map((activity) => activity.activityId), ["wactivity-3"]);
    assert.equal(
      thread.activities.some((activity) => activity.activityId === "wactivity-unassociated"),
      false,
    );
    assert.deepEqual(thread.selection, {
      kind: "turn-window",
      turnId: null,
      turnLimit: 1,
      turnOffset: 0,
      totalTurns: 3,
      selectedTurnIds: ["wturn-3"],
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ turnId: \"wturn-1\" } selects exactly that turn and its messages", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { turnId: "wturn-1" });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-1"]);
    assert.deepEqual(thread.messages.map((message) => message.messageId).sort(), ["wassistant-1", "wuser-1"].sort());
    assert.deepEqual(thread.activities.map((activity) => activity.activityId), ["wactivity-1"]);
    assert.deepEqual(thread.selection, {
      kind: "turn",
      turnId: "wturn-1",
      turnLimit: null,
      turnOffset: null,
      totalTurns: 3,
      selectedTurnIds: ["wturn-1"],
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ turnLimit: 2 } selects the two newest turns but emits them chronologically", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 2 });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-2", "wturn-3"]);
    assert.deepEqual(thread.selection, {
      kind: "turn-window",
      turnId: null,
      turnLimit: 2,
      turnOffset: 0,
      totalTurns: 3,
      selectedTurnIds: ["wturn-2", "wturn-3"],
    });

    // wassistant-2 matches both the turn_id IN and message_id IN clauses; the store must not
    // return it twice.
    const messageIds = thread.messages.map((message) => message.messageId);
    assert.deepEqual(messageIds, [...new Set(messageIds)]);
    assert.equal(messageIds.filter((id) => id === "wassistant-2").length, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("{ turnLimit: 1, turnOffset: 1 } selects the second-newest turn", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 1, turnOffset: 1 });

    assert.deepEqual(thread.turns.map((turn) => turn.turnId), ["wturn-2"]);
    assert.deepEqual(thread.selection, {
      kind: "turn-window",
      turnId: null,
      turnLimit: 1,
      turnOffset: 1,
      totalTurns: 3,
      selectedTurnIds: ["wturn-2"],
    });
  } finally {
    cleanupFixture(fixture);
  }
});

test("an empty but valid window returns normalized thread metadata with empty turns/messages/activities", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const emptyWindow = await client.getThread(WINDOW_THREAD_ID, { turnLimit: 1, turnOffset: 99 });

    assert.equal(emptyWindow.thread.id, WINDOW_THREAD_ID);
    assert.deepEqual(emptyWindow.turns, []);
    assert.deepEqual(emptyWindow.messages, []);
    assert.deepEqual(emptyWindow.activities, []);
    assert.equal(emptyWindow.selection.totalTurns, 3);

    const unmatchedTurn = await client.getThread(WINDOW_THREAD_ID, { turnId: "no-such-turn" });
    assert.equal(unmatchedTurn.thread.id, WINDOW_THREAD_ID);
    assert.deepEqual(unmatchedTurn.turns, []);
    assert.deepEqual(unmatchedTurn.messages, []);
    assert.deepEqual(unmatchedTurn.activities, []);
    assert.equal(unmatchedTurn.selection.totalTurns, 3);
  } finally {
    cleanupFixture(fixture);
  }
});

test("bounded retrieval still treats deleted or missing threads as not found", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    await assert.rejects(
      client.getThread(DELETED_PROJECT_TWO_THREAD_ID, { lastTurn: true }),
      (error) => error instanceof ThreadNotFoundError,
    );
    await assert.rejects(
      client.getThread("missing-thread-0001", { turnId: "any-turn" }),
      (error) => error instanceof ThreadNotFoundError,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("production reads do not modify the database", async () => {
  const fixture = createFixtureDatabase();
  try {
    const before = fs.statSync(fixture.databasePath);

    listThreadRowsFromDatabase(fixture.databasePath, {});
    readThreadWindowFromDatabase(fixture.databasePath, WINDOW_THREAD_ID, {
      kind: "turn-window",
      turnLimit: 1,
      turnOffset: 0,
    });

    const after = fs.statSync(fixture.databasePath);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    cleanupFixture(fixture);
  }
});

test("findThreads is oldest-first by default and reverse: true flips it", async () => {
  const fixture = createFixtureDatabase();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const forward = await client.findThreads({ title: "sanitized" });
    assert.deepEqual(forward.map((match) => match.id), [
      ACTIVE_THREAD_ID,
      ORPHAN_THREAD_ID,
      WINDOW_THREAD_ID,
      TIE_THREAD_A_ID,
      TIE_THREAD_B_ID,
      NULL_UPDATED_THREAD_ID,
    ]);

    const reverse = await client.findThreads({ title: "sanitized", reverse: true });
    assert.deepEqual(reverse.map((match) => match.id), [
      TIE_THREAD_B_ID,
      TIE_THREAD_A_ID,
      WINDOW_THREAD_ID,
      ORPHAN_THREAD_ID,
      ACTIVE_THREAD_ID,
      NULL_UPDATED_THREAD_ID,
    ]);

    // Literal wildcard handling must still hold under the new ordering.
    const database = new DatabaseSync(fixture.databasePath);
    database.prepare(`
      INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "reverse-percent-thread-0001",
      "project-1",
      "100% coverage",
      "2026-01-05T00:00:00.000Z",
      "2026-01-05T00:00:00.000Z",
      null,
    );
    database.close();
    const percentMatches = await client.findThreads({ title: "100%", reverse: true });
    assert.deepEqual(percentMatches.map((match) => match.id), ["reverse-percent-thread-0001"]);
  } finally {
    cleanupFixture(fixture);
  }
});
