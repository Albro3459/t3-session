import packageMetadata from "../package.json" with { type: "json" };

import { resolveConfig, resolveProviderLogPath, validateThreadId } from "./config.js";
import { inspectInstallation } from "./doctor.js";
import { normalizeThread, normalizeThreadSearchResult } from "./normalize.js";
import { readProviderJsonl } from "./provider-jsonl.js";
import {
  findThreadsFromDatabase,
  readThreadFromDatabase,
} from "./sqlite-store.js";

export const VERSION = packageMetadata.version;

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
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      return findThreadsFromDatabase(databasePath, requestOptions.title)
        .map(normalizeThreadSearchResult);
    },
    async readRawJsonl(threadId, requestOptions = {}) {
      validateThreadId(threadId);
      void requestOptions;
      const providerLogPath = resolveProviderLogPath(config, threadId);
      return readProviderJsonl(providerLogPath, { threadId });
    },
    async doctor(requestOptions = {}) {
      const databasePath = requestOptions.db || requestOptions.stateDb || config.stateDb;
      const doctorConfig = requestOptions.home === undefined
        ? { ...config, stateDb: databasePath }
        : resolveConfig({ home: requestOptions.home, db: databasePath });
      return inspectInstallation({ config: doctorConfig, toolVersion: VERSION });
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
  ProviderLogUnavailableError,
  RawJsonlPartiallyUnreadableError,
  SchemaUnavailableError,
  T3SessionError,
  ThreadNotFoundError,
  UnknownCommandError,
  serializeError,
} from "./errors.js";
export {
  normalizeThread,
  normalizeThreadSearchResult,
  parseJsonField,
  SCHEMA_VERSION,
} from "./normalize.js";
export {
  DOCTOR_SCHEMA_VERSION,
  doctorExitCode,
  formatDoctorHuman,
  inspectInstallation,
} from "./doctor.js";
export {
  READ_TIMEOUT_MS,
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  SQL,
  countProjectionRows,
  findThreadsFromDatabase,
  inspectRequiredSchema,
  listColumns,
  listTables,
  openReadonlyDatabase,
  readThreadFromDatabase,
  retrieveThreadRows,
  retrieveThreadSearchRows,
  validateRequiredTables,
} from "./sqlite-store.js";
export {
  parseProviderJsonl,
  readProviderJsonl,
  PROVIDER_LABELS,
} from "./provider-jsonl.js";
export {
  installBundledSkill,
  installSkill,
  resolveSkillInstallTarget,
  resolveSkillDestination,
  bundledSkillRoot,
  resolveBundledSkillRoot,
  validateBundledSkill,
  SkillInstallationError,
  SKILL_FILES,
  SKILL_NAME,
} from "./skill-install.js";
export {
  BUNDLED_SCHEMAS,
  formatBundledSchema,
  readBundledSchema,
  resolveSchemaPath,
} from "./schema.js";
