import { NotImplementedError } from "./errors.js";

export const TAIL_SCHEMA_VERSION = "t3-session.tail-record.v1";

export const TAIL_OPERATIONS = Object.freeze(["upsert", "live-state", "end"]);

export const TAIL_RECORD_TYPES = Object.freeze([
  "thread",
  "turn",
  "message",
  "activity",
  "live-state",
  "end",
]);

export const TAIL_END_REASONS = Object.freeze([
  "once",
  "max-cycles",
  "timeout",
  "interrupt",
  "thread-not-found",
]);

export const MAX_CONSECUTIVE_READ_FAILURES = 3;

// Implemented in Increment 2 wave 1. Yields t3-session.tail-record.v1 objects and always
// terminates with exactly one end record.
export async function* tailThreadRecords(threadId, options = {}) {
  void threadId;
  void options;
  throw new NotImplementedError("tail");
}
