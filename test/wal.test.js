import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createT3SessionClient, openReadonlyDatabase } from "../src/index.js";
import { ACTIVE_THREAD_ID, createFixtureDatabase } from "./fixtures/sqlite-fixture.js";

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test("opens a database read-only while a writer has a WAL", async () => {
  const fixture = createFixtureDatabase();
  const writer = new DatabaseSync(fixture.databasePath);
  try {
    const journalMode = writer.prepare("PRAGMA journal_mode = WAL").get().journal_mode;
    assert.equal(journalMode, "wal");
    writer.prepare(`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at,
        updated_at, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "message-wal",
      ACTIVE_THREAD_ID,
      "turn-2",
      "assistant",
      "WAL-visible sanitized message",
      0,
      "2026-01-01T00:03:00.000Z",
      "2026-01-01T00:03:00.000Z",
      null,
    );

    assert.equal(fs.existsSync(`${fixture.databasePath}-wal`), true);
    assert.equal(fs.existsSync(`${fixture.databasePath}-shm`), true);

    const readonlyDatabase = openReadonlyDatabase(fixture.databasePath);
    try {
      assert.throws(
        () => readonlyDatabase.exec("CREATE TABLE should_not_be_created (id INTEGER)"),
        /readonly/i,
      );
      assert.equal(
        readonlyDatabase.prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'should_not_be_created'",
        ).get(),
        undefined,
      );
    } finally {
      readonlyDatabase.close();
    }

    const client = await createT3SessionClient({ db: fixture.databasePath });
    const thread = await client.getThread(ACTIVE_THREAD_ID);
    assert.equal(thread.messages.at(-1).messageId, "message-wal");
  } finally {
    writer.close();
    cleanupFixture(fixture);
  }
});
