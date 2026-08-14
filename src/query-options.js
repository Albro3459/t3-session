import { InvalidArgumentsError } from "./errors.js";

export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_TURN_LIMIT = 1;
export const DEFAULT_TAIL_INTERVAL_MS = 1000;
// A tighter poll offers nothing against a projection that updates per turn, and an
// unbounded one is a foot-gun.
export const MIN_TAIL_INTERVAL_MS = 100;
export const MAX_TAIL_INTERVAL_MS = 60000;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/u;
const DIGITS = /^\d+$/u;

export function normalizeTimestamp(value, field) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const trimmed = typeof value === "string" ? value.trim() : value;
  const match = typeof trimmed === "string" ? ISO_TIMESTAMP.exec(trimmed) : null;
  if (!match) {
    throw new InvalidArgumentsError(`${field} must be an ISO-8601 timestamp.`, { field, value });
  }

  // A date-time with no UTC offset is ambiguous under `new Date(...)`, which parses that
  // form in the host's local timezone while stored values are UTC. Treat it as UTC instead,
  // matching date-only input (which `Date` already parses as UTC) and matching storage.
  const hasTimeComponent = match[1] !== undefined;
  const hasOffset = match[4] !== undefined;
  const forParsing = hasTimeComponent && !hasOffset
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;

  const parsed = new Date(forParsing);
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

// A limit of 0 parses as a valid non-negative integer but returns nothing, which is
// indistinguishable from an empty result. Limits must be positive; offsets stay non-negative.
export function normalizePositiveCount(value, field, fallback) {
  const count = normalizeCount(value, field, fallback);
  if (count !== null && count !== undefined && count < 1) {
    throw new InvalidArgumentsError(`${field} must be a positive integer.`, { field, value });
  }

  return count;
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
    limit: normalizePositiveCount(options.limit, "limit", DEFAULT_LIST_LIMIT),
    offset: normalizeCount(options.offset, "offset", 0),
    reverse: normalizeFlag(options.reverse, "reverse"),
  });
}

function isUnset(value) {
  return value === undefined || value === null || value === "";
}

function normalizeBoundedCount(value, field, { min, max = null }) {
  if (isUnset(value)) {
    return null;
  }

  const count = normalizeCount(value, field, null);
  if (count < min || (max !== null && count > max)) {
    throw new InvalidArgumentsError(
      max === null
        ? `${field} must be an integer of at least ${min}.`
        : `${field} must be an integer between ${min} and ${max}.`,
      { field, value },
    );
  }

  return count;
}

export function normalizeTailOptions(options = {}) {
  const once = normalizeFlag(options.once, "once");
  const maxCycles = normalizeBoundedCount(options.maxCycles, "maxCycles", { min: 1 });
  const timeoutMs = normalizeBoundedCount(options.timeoutMs, "timeoutMs", { min: 1 });

  if (once && (!isUnset(options.intervalMs) || maxCycles !== null || timeoutMs !== null)) {
    throw new InvalidArgumentsError(
      "once cannot be combined with intervalMs, maxCycles, or timeoutMs.",
      { field: "once" },
    );
  }

  const intervalMs = isUnset(options.intervalMs)
    ? DEFAULT_TAIL_INTERVAL_MS
    : normalizeBoundedCount(options.intervalMs, "intervalMs", {
        min: MIN_TAIL_INTERVAL_MS,
        max: MAX_TAIL_INTERVAL_MS,
      });

  return Object.freeze({
    once,
    intervalMs,
    maxCycles,
    timeoutMs,
    selection: normalizeTurnSelection({ turnLimit: options.turnLimit }),
    // An unbounded tail never finishes, so buffered output formats must reject it.
    bounded: once || maxCycles !== null || timeoutMs !== null,
  });
}

// limit defaults to null, meaning every participant. A silent default cap would answer
// "who worked on this thread" with a truncated list, which is worse than a long one.
export function normalizeParticipantOptions(options = {}) {
  return Object.freeze({
    selection: normalizeTurnSelection(options),
    reverse: normalizeFlag(options.reverse, "reverse"),
    tree: normalizeFlag(options.tree, "tree"),
    limit: normalizePositiveCount(options.limit, "limit", null),
    offset: normalizeCount(options.offset, "offset", 0),
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
    turnLimit: normalizePositiveCount(options.turnLimit, "turnLimit", DEFAULT_TURN_LIMIT),
    turnOffset: normalizeCount(options.turnOffset, "turnOffset", 0),
  });
}
