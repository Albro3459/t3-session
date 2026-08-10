import { DatabaseSync } from "node:sqlite";

import {
  DatabaseUnavailableError,
  SchemaUnavailableError,
  ThreadNotFoundError,
} from "./errors.js";

export const READ_TIMEOUT_MS = 250;

export const REQUIRED_TABLES = Object.freeze([
  "projection_threads",
  "projection_projects",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_sessions",
  "projection_turns",
]);

export const REQUIRED_COLUMNS = Object.freeze({
  projection_threads: Object.freeze([
    "thread_id", "project_id", "title", "branch", "worktree_path", "latest_turn_id",
    "created_at", "updated_at", "latest_user_message_at", "deleted_at", "runtime_mode",
    "interaction_mode", "model_selection_json",
  ]),
  projection_projects: Object.freeze(["project_id", "title", "workspace_root"]),
  projection_thread_messages: Object.freeze([
    "message_id", "thread_id", "turn_id", "role", "text", "is_streaming", "created_at",
    "updated_at", "attachments_json",
  ]),
  projection_thread_activities: Object.freeze([
    "activity_id", "thread_id", "turn_id", "tone", "kind", "summary", "payload_json",
    "created_at", "sequence",
  ]),
  projection_thread_sessions: Object.freeze([
    "thread_id", "status", "provider_name", "provider_session_id", "provider_thread_id",
    "provider_instance_id", "last_error",
  ]),
  projection_turns: Object.freeze([
    "row_id", "thread_id", "turn_id", "pending_message_id", "assistant_message_id", "state",
    "requested_at", "started_at", "completed_at", "checkpoint_turn_count", "checkpoint_ref",
    "checkpoint_status", "checkpoint_files_json",
  ]),
});

const THREAD_QUERY = `
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
    p.project_id AS project_join_id,
    p.title AS project_title,
    p.workspace_root
  FROM projection_threads AS t
  LEFT JOIN projection_projects AS p
    ON p.project_id = t.project_id
  WHERE t.thread_id = ?
    AND t.deleted_at IS NULL
`;

const MESSAGES_QUERY = `
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
  ORDER BY created_at, message_id
`;

const ACTIVITIES_QUERY = `
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
  ORDER BY created_at, activity_id
`;

const TURNS_QUERY = `
  SELECT *
  FROM projection_turns
  WHERE thread_id = ?
  ORDER BY row_id
`;

const PROVIDER_QUERY = `
  SELECT *
  FROM projection_thread_sessions
  WHERE thread_id = ?
`;

export const SQL = Object.freeze({
  THREAD_QUERY,
  MESSAGES_QUERY,
  ACTIVITIES_QUERY,
  TURNS_QUERY,
  PROVIDER_QUERY,
});

function detailsFor(path, operation) {
  return { path, operation };
}

export function openReadonlyDatabase(databasePath) {
  try {
    return new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: READ_TIMEOUT_MS,
    });
  } catch (error) {
    throw new DatabaseUnavailableError(
      `Unable to open the SQLite database: ${databasePath}`,
      detailsFor(databasePath, "open"),
      error,
    );
  }
}

export function listTables(database) {
  try {
    return database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => row.name);
  } catch (error) {
    throw new DatabaseUnavailableError(
      "Unable to inspect the SQLite database schema.",
      { operation: "list-tables" },
      error,
    );
  }
}

function listColumns(database, table) {
  try {
    return database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
  } catch (error) {
    throw new DatabaseUnavailableError(
      `Unable to inspect the ${table} table schema.`,
      { operation: "list-columns", table },
      error,
    );
  }
}

export function validateRequiredTables(database) {
  const presentTables = new Set(listTables(database));
  const missingTables = REQUIRED_TABLES.filter((table) => !presentTables.has(table));
  const missingColumns = {};

  for (const table of REQUIRED_TABLES) {
    if (!presentTables.has(table)) {
      continue;
    }

    const presentColumns = new Set(listColumns(database, table));
    const missing = REQUIRED_COLUMNS[table].filter((column) => !presentColumns.has(column));
    if (missing.length > 0) {
      missingColumns[table] = missing;
    }
  }

  if (missingTables.length > 0 || Object.keys(missingColumns).length > 0) {
    throw new SchemaUnavailableError(missingTables, {
      operation: "validate-schema",
      requiredTables: [...REQUIRED_TABLES],
      requiredColumns: REQUIRED_COLUMNS,
      missingColumns,
    });
  }

  return Object.freeze({
    requiredTables: [...REQUIRED_TABLES],
    presentTables: [...presentTables],
    requiredColumns: REQUIRED_COLUMNS,
  });
}

function queryAll(database, sql, threadId, operation) {
  try {
    return database.prepare(sql).all(threadId);
  } catch (error) {
    throw new DatabaseUnavailableError(
      `Unable to retrieve ${operation} from the SQLite database.`,
      { operation },
      error,
    );
  }
}

export function retrieveThreadRows(database, threadId) {
  const thread = queryAll(database, THREAD_QUERY, threadId, "thread")[0];
  if (!thread) {
    throw new ThreadNotFoundError(threadId);
  }

  return {
    thread,
    turns: queryAll(database, TURNS_QUERY, threadId, "turns"),
    messages: queryAll(database, MESSAGES_QUERY, threadId, "messages"),
    activities: queryAll(database, ACTIVITIES_QUERY, threadId, "activities"),
    provider: queryAll(database, PROVIDER_QUERY, threadId, "provider")[0] || null,
  };
}

export function readThreadFromDatabase(databasePath, threadId) {
  const database = openReadonlyDatabase(databasePath);
  let transactionStarted = false;
  try {
    database.exec("BEGIN DEFERRED");
    transactionStarted = true;
    validateRequiredTables(database);
    return retrieveThreadRows(database, threadId);
  } finally {
    if (transactionStarted) {
      database.exec("ROLLBACK");
    }
    database.close();
  }
}
