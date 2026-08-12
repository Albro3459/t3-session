import { DatabaseSync } from "node:sqlite";

// Mutation helpers for live-state and tail tests. They deliberately live outside
// createFixtureDatabase() so its row counts stay exactly as the doctor tests assert.

function withWriter(databasePath, run) {
  const database = new DatabaseSync(databasePath);
  try {
    return run(database);
  } finally {
    database.close();
  }
}

export function enableWalMode(databasePath) {
  return withWriter(
    databasePath,
    (database) => database.prepare("PRAGMA journal_mode = WAL").get().journal_mode,
  );
}

export function appendMessage(databasePath, {
  messageId,
  threadId,
  turnId = null,
  role = "assistant",
  text = "",
  isStreaming = 0,
  createdAt = null,
  updatedAt = null,
  attachmentsJson = null,
}) {
  withWriter(databasePath, (database) => {
    database.prepare(`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at,
        updated_at, attachments_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      messageId,
      threadId,
      turnId,
      role,
      text,
      isStreaming,
      createdAt,
      updatedAt,
      attachmentsJson,
    );
  });
}

// Rewrites an existing row in place. Pass only text to change content without touching
// updated_at, which is how streaming text mutates in the real projection.
export function updateMessage(databasePath, messageId, { text, updatedAt, isStreaming } = {}) {
  withWriter(databasePath, (database) => {
    if (text !== undefined) {
      database
        .prepare("UPDATE projection_thread_messages SET text = ? WHERE message_id = ?")
        .run(text, messageId);
    }
    if (updatedAt !== undefined) {
      database
        .prepare("UPDATE projection_thread_messages SET updated_at = ? WHERE message_id = ?")
        .run(updatedAt, messageId);
    }
    if (isStreaming !== undefined) {
      database
        .prepare("UPDATE projection_thread_messages SET is_streaming = ? WHERE message_id = ?")
        .run(isStreaming, messageId);
    }
  });
}

export function insertTurn(databasePath, {
  threadId,
  turnId,
  pendingMessageId = null,
  assistantMessageId = null,
  state = "streaming",
  requestedAt = null,
  startedAt = null,
  completedAt = null,
}) {
  withWriter(databasePath, (database) => {
    database.prepare(`
      INSERT INTO projection_turns (
        thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
        source_proposed_plan_id, assistant_message_id, state, requested_at, started_at,
        completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
        checkpoint_files_json
      ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)
    `).run(
      threadId,
      turnId,
      pendingMessageId,
      assistantMessageId,
      state,
      requestedAt,
      startedAt,
      completedAt,
    );
  });
}

export function setTurnState(databasePath, threadId, turnId, state, { completedAt } = {}) {
  withWriter(databasePath, (database) => {
    database
      .prepare("UPDATE projection_turns SET state = ? WHERE thread_id = ? AND turn_id = ?")
      .run(state, threadId, turnId);
    if (completedAt !== undefined) {
      database
        .prepare("UPDATE projection_turns SET completed_at = ? WHERE thread_id = ? AND turn_id = ?")
        .run(completedAt, threadId, turnId);
    }
  });
}

export function setSessionStatus(databasePath, threadId, status) {
  withWriter(databasePath, (database) => {
    const updated = database
      .prepare("UPDATE projection_thread_sessions SET status = ? WHERE thread_id = ?")
      .run(status, threadId);
    if (updated.changes === 0) {
      database.prepare(`
        INSERT INTO projection_thread_sessions (
          thread_id, provider_name, provider_session_id, provider_thread_id,
          provider_instance_id, status, last_error
        ) VALUES (?, 'SanitizedProvider', NULL, NULL, NULL, ?, NULL)
      `).run(threadId, status);
    }
  });
}

export function deleteSession(databasePath, threadId) {
  withWriter(databasePath, (database) => {
    database
      .prepare("DELETE FROM projection_thread_sessions WHERE thread_id = ?")
      .run(threadId);
  });
}

export function setThreadLatestTurn(databasePath, threadId, latestTurnId) {
  withWriter(databasePath, (database) => {
    database
      .prepare("UPDATE projection_threads SET latest_turn_id = ? WHERE thread_id = ?")
      .run(latestTurnId, threadId);
  });
}

// Soft-deletes the thread the way the projection does, so retrieval stops finding it.
export function deleteThread(databasePath, threadId, deletedAt = "2026-02-09T00:00:00.000Z") {
  withWriter(databasePath, (database) => {
    database
      .prepare("UPDATE projection_threads SET deleted_at = ? WHERE thread_id = ?")
      .run(deletedAt, threadId);
  });
}
