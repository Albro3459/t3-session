import { InvalidArgumentsError } from "./errors.js";

export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_TURN_LIMIT = 1;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/u;
const DIGITS = /^\d+$/u;

export function normalizeTimestamp(value, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value.trim())) {
    throw new InvalidArgumentsError(`${field} must be an ISO-8601 timestamp.`, { field, value });
  }

  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidArgumentsError(`${field} must be an ISO-8601 timestamp.`, { field, value });
  }

  return parsed.toISOString();
}

export function normalizeCount(value, field, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (typeof value === "string") {
    if (!DIGITS.test(value.trim())) {
      throw new InvalidArgumentsError(`${field} must be a non-negative integer.`, { field, value });
    }

    return Number.parseInt(value.trim(), 10);
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentsError(`${field} must be a non-negative integer.`, { field, value });
  }

  return value;
}

export function normalizeProjectFilter(value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidArgumentsError("project must be a non-empty string.", {
      field: "project",
      value,
    });
  }

  return value.trim();
}

function normalizeFlag(value, field) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new InvalidArgumentsError(`${field} must be a boolean.`, { field, value });
  }

  return value;
}

export function normalizeListOptions(options = {}) {
  return Object.freeze({
    project: normalizeProjectFilter(options.project),
    since: normalizeTimestamp(options.since, "since"),
    before: normalizeTimestamp(options.before, "before"),
    limit: normalizeCount(options.limit, "limit", DEFAULT_LIST_LIMIT),
    offset: normalizeCount(options.offset, "offset", 0),
    reverse: normalizeFlag(options.reverse, "reverse"),
  });
}

export function normalizeTurnSelection(options = {}) {
  const lastTurn = normalizeFlag(options.lastTurn, "lastTurn");
  const hasWindow = options.turnLimit !== undefined || options.turnOffset !== undefined;

  if (options.turnId !== undefined && options.turnId !== null) {
    if (lastTurn || hasWindow) {
      throw new InvalidArgumentsError(
        "turnId cannot be combined with lastTurn, turnLimit, or turnOffset.",
        { field: "turnId" },
      );
    }

    if (typeof options.turnId !== "string" || options.turnId.trim() === "") {
      throw new InvalidArgumentsError("turnId must be a non-empty string.", {
        field: "turnId",
        value: options.turnId,
      });
    }

    return Object.freeze({ kind: "turn", turnId: options.turnId.trim() });
  }

  if (lastTurn && hasWindow) {
    throw new InvalidArgumentsError("lastTurn cannot be combined with turnLimit or turnOffset.", {
      field: "lastTurn",
    });
  }

  if (lastTurn) {
    return Object.freeze({ kind: "turn-window", turnLimit: 1, turnOffset: 0 });
  }

  if (!hasWindow) {
    return null;
  }

  return Object.freeze({
    kind: "turn-window",
    turnLimit: normalizeCount(options.turnLimit, "turnLimit", DEFAULT_TURN_LIMIT),
    turnOffset: normalizeCount(options.turnOffset, "turnOffset", 0),
  });
}
