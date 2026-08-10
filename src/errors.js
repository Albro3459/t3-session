export const ERROR_SCHEMA_VERSION = "t3-session.error.v1";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  UNEXPECTED_FAILURE: 1,
  THREAD_NOT_FOUND: 2,
  INVALID_ARGUMENTS: 3,
  DATABASE_UNAVAILABLE: 4,
  RAW_JSONL_PARTIALLY_UNREADABLE: 5,
});

export class T3SessionError extends Error {
  constructor(message, { code = "T3_SESSION_ERROR", exitCode = EXIT_CODES.UNEXPECTED_FAILURE, details = {}, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "T3SessionError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }

  toJSON() {
    return serializeError(this);
  }
}

export class ConfigurationError extends T3SessionError {
  constructor(message, details = {}) {
    super(message, {
      code: "INVALID_CONFIGURATION",
      exitCode: EXIT_CODES.INVALID_ARGUMENTS,
      details,
    });
    this.name = "ConfigurationError";
  }
}

export class InvalidArgumentsError extends T3SessionError {
  constructor(message, details = {}) {
    super(message, {
      code: "INVALID_ARGUMENTS",
      exitCode: EXIT_CODES.INVALID_ARGUMENTS,
      details,
    });
    this.name = "InvalidArgumentsError";
  }
}

export class UnknownCommandError extends InvalidArgumentsError {
  constructor(command) {
    super(`Unknown command: ${command}`, { command });
    this.name = "UnknownCommandError";
    this.code = "UNKNOWN_COMMAND";
  }
}

export class ThreadNotFoundError extends T3SessionError {
  constructor(threadId) {
    super("No thread matched the supplied ID.", {
      code: "THREAD_NOT_FOUND",
      exitCode: EXIT_CODES.THREAD_NOT_FOUND,
      details: { threadId },
    });
    this.name = "ThreadNotFoundError";
  }
}

export class DatabaseUnavailableError extends T3SessionError {
  constructor(message, details = {}, cause) {
    super(message, {
      code: "DATABASE_UNAVAILABLE",
      exitCode: EXIT_CODES.DATABASE_UNAVAILABLE,
      details,
      cause,
    });
    this.name = "DatabaseUnavailableError";
  }
}

export class SchemaUnavailableError extends DatabaseUnavailableError {
  constructor(missingTables = [], details = {}) {
    const missingColumns = details.missingColumns || {};
    const missingDescription = missingTables.length > 0
      ? "required projection tables"
      : "required projection columns";
    super(`The SQLite database is missing ${missingDescription}.`, {
      ...details,
      missingTables,
      missingColumns,
    });
    this.name = "SchemaUnavailableError";
    this.code = "SCHEMA_UNAVAILABLE";
  }
}

export class NotImplementedError extends T3SessionError {
  constructor(command) {
    super(`The \"${command}\" command is not implemented yet.`, {
      code: "NOT_IMPLEMENTED",
      exitCode: EXIT_CODES.UNEXPECTED_FAILURE,
      details: { command },
    });
    this.name = "NotImplementedError";
  }
}

export function isT3SessionError(error) {
  return error instanceof T3SessionError;
}

export function toT3SessionError(error) {
  if (isT3SessionError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return new T3SessionError(error.message, { cause: error });
  }

  return new T3SessionError(String(error));
}

export function serializeError(error) {
  const normalized = toT3SessionError(error);
  return {
    schemaVersion: ERROR_SCHEMA_VERSION,
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
  };
}
