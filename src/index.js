import packageMetadata from "../package.json" with { type: "json" };

import { resolveConfig, validateThreadId } from "./config.js";
import { NotImplementedError } from "./errors.js";
import { normalizeThread } from "./normalize.js";
import { readThreadFromDatabase } from "./sqlite-store.js";

export const VERSION = packageMetadata.version;

function unavailable(method) {
  throw new NotImplementedError(method);
}

export async function createT3SessionClient(options = {}) {
  const config = resolveConfig(options);

  return Object.freeze({
    config,
    async getThread(threadId, requestOptions = {}) {
      validateThreadId(threadId);
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      const rows = readThreadFromDatabase(databasePath, threadId);
      return normalizeThread(rows, { toolVersion: VERSION });
    },
    async findThreads(requestOptions = {}) {
      void requestOptions;
      return unavailable("findThreads");
    },
    async readRawJsonl(threadId, requestOptions = {}) {
      void threadId;
      void requestOptions;
      return unavailable("readRawJsonl");
    },
    async doctor(requestOptions = {}) {
      void requestOptions;
      return unavailable("doctor");
    },
  });
}

export { resolveConfig, resolveProviderLogPath, validateThreadId } from "./config.js";
export {
  ConfigurationError,
  DatabaseUnavailableError,
  EXIT_CODES,
  InvalidArgumentsError,
  NotImplementedError,
  SchemaUnavailableError,
  T3SessionError,
  ThreadNotFoundError,
  UnknownCommandError,
  serializeError,
} from "./errors.js";
export { normalizeThread, parseJsonField, SCHEMA_VERSION } from "./normalize.js";
export {
  READ_TIMEOUT_MS,
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  SQL,
  listTables,
  openReadonlyDatabase,
  readThreadFromDatabase,
  retrieveThreadRows,
  validateRequiredTables,
} from "./sqlite-store.js";
