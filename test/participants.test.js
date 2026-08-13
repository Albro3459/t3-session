import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createT3SessionClient, EXIT_CODES, ThreadNotFoundError } from "../src/index.js";
import {
  isTerminalTaskStatus,
  normalizeParticipants,
  TASK_ACTIVITY_KINDS,
  TERMINAL_TASK_STATUSES,
} from "../src/participants.js";
import {
  BROKEN_THREAD_ID,
  createParticipantFixture,
  CYCLE_SCOPE_THREAD_ID,
  DELETED_THREAD_ID,
  EMPTY_THREAD_ID,
  FLAT_THREAD_ID,
  SELF_PARENT_THREAD_ID,
  TREE_THREAD_ID,
  TYPE_COERCION_THREAD_ID,
  USAGE_FOLD_THREAD_ID,
} from "./fixtures/participant-fixture.js";

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "participants.v1.json",
);
const participantsSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));

function cleanupFixture(fixture) {
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

function byTaskId(view, taskId) {
  const found = view.participants.find((participant) => participant.taskId === taskId);
  assert.ok(found, `expected a participant for taskId "${taskId}"`);
  return found;
}

// Type-checks a single value against a JSON-schema "type" (a string or a union array), plus
// integer/array/object refinements the plain typeof operator can't express. This is what
// turns the validator from a key-presence check into one that would have caught a non-string
// taskId or an object landing where a scalar was declared.
function typeMatches(value, type) {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    default: return false;
  }
}

function assertDeclaredType(value, propertySchema, label) {
  const types = Array.isArray(propertySchema.type) ? propertySchema.type : [propertySchema.type];
  assert.ok(
    types.some((type) => typeMatches(value, type)),
    `${label} expected type ${types.join("|")} but got ${JSON.stringify(value)}`,
  );
}

// Recursively validates a participant (and, for --tree output, its nested children)
// against the schema's participant definition, the same way live-state.test.js and
// output-ordering.test.js hand-roll schema conformance without a JSON-schema dependency.
// Beyond required/unexpected keys, this now enforces the declared type of every field, so a
// wrong-typed value (eg. a numeric taskId, or a non-boolean isBackgrounded) fails here rather
// than only being caught by a field-specific assertion elsewhere.
function assertValidParticipant(participant, participantSchema) {
  for (const key of participantSchema.required) {
    assert.ok(Object.hasOwn(participant, key), `participant missing required key "${key}"`);
  }
  for (const key of Object.keys(participant)) {
    assert.ok(
      Object.hasOwn(participantSchema.properties, key),
      `participant has unexpected key "${key}"`,
    );
  }
  for (const [key, propertySchema] of Object.entries(participantSchema.properties)) {
    if (key === "children" || !Object.hasOwn(participant, key)) {
      continue;
    }
    assertDeclaredType(participant[key], propertySchema, `participant.${key}`);
  }
  assert.ok(
    participantSchema.properties.state.enum.includes(participant.state),
    `unexpected state "${participant.state}"`,
  );

  const usageSchema = participantSchema.properties.usage;
  for (const key of usageSchema.required) {
    assert.ok(Object.hasOwn(participant.usage, key), `usage missing required key "${key}"`);
  }
  for (const [key, propertySchema] of Object.entries(usageSchema.properties)) {
    assertDeclaredType(participant.usage[key], propertySchema, `participant.usage.${key}`);
  }

  if (Object.hasOwn(participant, "children")) {
    for (const child of participant.children) {
      assertValidParticipant(child, participantSchema);
    }
  }
}

function assertValidEnvelope(envelope) {
  for (const key of participantsSchema.required) {
    assert.ok(Object.hasOwn(envelope, key), `envelope missing required key "${key}"`);
  }
  for (const key of Object.keys(envelope)) {
    assert.ok(
      Object.hasOwn(participantsSchema.properties, key),
      `envelope has unexpected key "${key}"`,
    );
  }
  for (const key of participantsSchema.properties.counts.required) {
    assert.ok(Object.hasOwn(envelope.counts, key), `counts missing required key "${key}"`);
  }
  for (const key of Object.keys(envelope.counts)) {
    assert.ok(
      Object.hasOwn(participantsSchema.properties.counts.properties, key),
      `counts has unexpected key "${key}"`,
    );
  }
  for (const [key, propertySchema] of Object.entries(participantsSchema.properties.counts.properties)) {
    assertDeclaredType(envelope.counts[key], propertySchema, `counts.${key}`);
  }
  for (const participant of envelope.participants) {
    assertValidParticipant(participant, participantsSchema.$defs.participant);
  }
}

test("TERMINAL_TASK_STATUSES and TASK_ACTIVITY_KINDS match the plan's frozen constants", () => {
  assert.ok(Object.isFrozen(TERMINAL_TASK_STATUSES));
  assert.deepEqual([...TERMINAL_TASK_STATUSES].sort(), ["cancelled", "completed", "failed", "stopped"]);

  assert.ok(Object.isFrozen(TASK_ACTIVITY_KINDS));
  assert.deepEqual(
    [...TASK_ACTIVITY_KINDS].sort(),
    ["task.completed", "task.progress", "task.started", "task.updated"],
  );

  for (const status of TERMINAL_TASK_STATUSES) {
    assert.equal(isTerminalTaskStatus(status), true, `expected "${status}" to be terminal`);
  }
  assert.equal(isTerminalTaskStatus("gremlin"), false);
  assert.equal(isTerminalTaskStatus(" Completed "), true);
  assert.equal(isTerminalTaskStatus(null), false);
});

test("multiple task.* activities sharing a taskId fold into exactly one participant", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    assert.equal(view.participants.length, 3);
    assert.deepEqual(
      view.participants.map((participant) => participant.taskId).sort(),
      ["task-alpha", "task-beta", "task-gamma"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("last non-null wins without erasing fields a later activity omits", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);
    const alpha = byTaskId(view, "task-alpha");

    assert.equal(alpha.role, "general-purpose");
    assert.equal(alpha.model, "model-a");
    assert.equal(alpha.title, "Alpha task");
    assert.equal(alpha.agentKind, "agent");
    assert.equal(alpha.taskType, "local_agent");
    assert.equal(alpha.effort, "high");
    assert.equal(alpha.toolUseId, "tool-use-alpha");
    assert.equal(alpha.lastToolName, "Read");
    assert.equal(alpha.status, "completed");
    assert.equal(alpha.summary, "Alpha done");
  } finally {
    cleanupFixture(fixture);
  }
});

test("firstSeenAt, lastSeenAt, activityCount, turnId, and turnIds are computed for task-alpha", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);
    const alpha = byTaskId(view, "task-alpha");

    assert.equal(alpha.firstSeenAt, "2026-03-01T00:00:20.000Z");
    assert.equal(alpha.lastSeenAt, "2026-03-01T00:00:40.000Z");
    assert.equal(alpha.activityCount, 3);
    assert.equal(alpha.turnId, "pturn-1");
    assert.deepEqual(alpha.turnIds, ["pturn-1"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("state mapping: terminal status finishes, missing status is unknown, unrecognised status keeps running", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    const alpha = byTaskId(view, "task-alpha");
    assert.equal(alpha.status, "completed");
    assert.equal(alpha.state, "finished");

    const beta = byTaskId(view, "task-beta");
    assert.equal(beta.status, null);
    assert.equal(beta.state, "unknown");

    const gamma = byTaskId(view, "task-gamma");
    assert.equal(gamma.status, "gremlin");
    assert.equal(gamma.state, "running");
  } finally {
    cleanupFixture(fixture);
  }
});

test("usage prefers typedUsage over snake_case usage, and unknown values are null rather than zero", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    const alpha = byTaskId(view, "task-alpha");
    assert.deepEqual(alpha.usage, { totalTokens: 1500, toolUses: 5, durationMs: 6000 });

    const beta = byTaskId(view, "task-beta");
    assert.deepEqual(beta.usage, { totalTokens: null, toolUses: null, durationMs: null });
  } finally {
    cleanupFixture(fixture);
  }
});

test("unmodelled projected keys land in adapterSpecific and never at the top level", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);
    const alpha = byTaskId(view, "task-alpha");

    assert.equal(alpha.adapterSpecific.phaseIndex, 2);
    assert.deepEqual(alpha.adapterSpecific.runHandles, { runId: "run-1" });
    assert.equal(Object.hasOwn(alpha, "phaseIndex"), false);
    assert.equal(Object.hasOwn(alpha, "runHandles"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("non-task activities are ignored and a tool argument taskId does not add an activity", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    assert.equal(view.participants.length, 3);
    const alpha = byTaskId(view, "task-alpha");
    // pa-8 (tool.started) carries data.input.taskId "task-alpha" but must not be folded in:
    // only pa-1, pa-3, pa-4 (the three task.* rows) contribute.
    assert.equal(alpha.activityCount, 3);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a thread with no task activities returns a valid empty envelope, not an error", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(EMPTY_THREAD_ID);

    assert.deepEqual(view.participants, []);
    assert.equal(view.counts.total, 0);
    assert.equal(view.hierarchyAvailable, false);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a soft-deleted thread and a nonexistent thread both raise ThreadNotFoundError with exitCode 2", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });

    await assert.rejects(
      () => client.listParticipants(DELETED_THREAD_ID),
      (error) => {
        assert.ok(error instanceof ThreadNotFoundError);
        assert.equal(error.exitCode, EXIT_CODES.THREAD_NOT_FOUND);
        return true;
      },
    );

    await assert.rejects(
      () => client.listParticipants("participant-nonexistent-thread"),
      (error) => {
        assert.ok(error instanceof ThreadNotFoundError);
        assert.equal(error.exitCode, EXIT_CODES.THREAD_NOT_FOUND);
        return true;
      },
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("a malformed payload warns without throwing or dropping the thread's other participants, and a taskId-less payload is skipped", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(BROKEN_THREAD_ID);

    assert.deepEqual(
      view.participants.map((participant) => participant.taskId).sort(),
      ["cycle-a", "cycle-b", "orphan-task", "tie-a-task", "tie-b-task"],
    );

    const malformedWarning = view.warnings.find((warning) => warning.code === "MALFORMED_JSON");
    assert.ok(malformedWarning, "expected a MALFORMED_JSON warning");
  } finally {
    cleanupFixture(fixture);
  }
});

test("ordering is oldest-first by firstSeenAt with a taskId tie-breaker, and --reverse flips it", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const ascending = await client.listParticipants(BROKEN_THREAD_ID);

    assert.deepEqual(
      ascending.participants.map((participant) => participant.taskId),
      ["orphan-task", "cycle-a", "cycle-b", "tie-a-task", "tie-b-task"],
    );

    const descending = await client.listParticipants(BROKEN_THREAD_ID, { reverse: true });
    assert.deepEqual(
      descending.participants.map((participant) => participant.taskId),
      ["tie-b-task", "tie-a-task", "cycle-b", "cycle-a", "orphan-task"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("a null firstSeenAt sorts last in both ascending and reversed order", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const ascending = await client.listParticipants(TREE_THREAD_ID);
    const descending = await client.listParticipants(TREE_THREAD_ID, { reverse: true });

    assert.equal(ascending.participants.at(-1).taskId, "null-time-task");
    // Per the Increment 1 null-timestamp rule (reused here, not reimplemented), a null
    // firstSeenAt sorts last in BOTH directions -- it must not become first on reverse.
    assert.equal(descending.participants.at(-1).taskId, "null-time-task");
  } finally {
    cleanupFixture(fixture);
  }
});

test("limit and offset page the result while counts.total reports the full match count", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const page = await client.listParticipants(BROKEN_THREAD_ID, { limit: 2, offset: 1 });

    assert.equal(page.counts.total, 5);
    assert.equal(page.participants.length, 2);
    assert.deepEqual(
      page.participants.map((participant) => participant.taskId),
      ["cycle-a", "cycle-b"],
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("a resolvable parentAgentId produces parentTaskId, depth, and path three levels deep", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID);

    const root = byTaskId(view, "root-task");
    assert.equal(root.parentTaskId, null);
    assert.equal(root.depth, 0);
    assert.equal(root.path, "main.subagent1");

    const child = byTaskId(view, "child-task");
    assert.equal(child.parentTaskId, "root-task");
    assert.equal(child.depth, 1);
    assert.equal(child.path, "main.subagent1.subagent1a");

    const grandchild = byTaskId(view, "grandchild-task");
    assert.equal(grandchild.parentTaskId, "child-task");
    assert.equal(grandchild.depth, 2);
    assert.equal(grandchild.path, "main.subagent1.subagent1a.subagent1a1");

    const secondChild = byTaskId(view, "second-child-task");
    assert.equal(secondChild.parentTaskId, "root-task");
    assert.equal(secondChild.depth, 1);
    assert.equal(secondChild.path, "main.subagent1.subagent1b");
  } finally {
    cleanupFixture(fixture);
  }
});

test("hierarchyAvailable is true only when at least one edge resolves", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });

    const tree = await client.listParticipants(TREE_THREAD_ID);
    assert.equal(tree.hierarchyAvailable, true);

    const flat = await client.listParticipants(FLAT_THREAD_ID);
    assert.equal(flat.hierarchyAvailable, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("an unresolved parentAgentId leaves parentTaskId and path null and emits UNRESOLVED_PARENT", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(BROKEN_THREAD_ID);
    const orphan = byTaskId(view, "orphan-task");

    assert.equal(orphan.parentTaskId, null);
    assert.equal(orphan.path, null);

    const warning = view.warnings.find((entry) => entry.code === "UNRESOLVED_PARENT");
    assert.ok(warning, "expected an UNRESOLVED_PARENT warning");
    assert.equal(warning.details.taskId, "orphan-task");
    assert.equal(warning.details.parentAgentId, "missing-parent-task");
    assert.equal(view.counts.unresolvedParents, 1);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a parent cycle terminates, reports both members as roots, and emits one PARENT_CYCLE warning", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(BROKEN_THREAD_ID);

    const cycleA = byTaskId(view, "cycle-a");
    const cycleB = byTaskId(view, "cycle-b");
    assert.equal(cycleA.parentTaskId, null);
    assert.equal(cycleB.parentTaskId, null);
    assert.equal(cycleA.path, null);
    assert.equal(cycleB.path, null);

    const cycleWarnings = view.warnings.filter((entry) => entry.code === "PARENT_CYCLE");
    assert.equal(cycleWarnings.length, 1);
    assert.deepEqual(cycleWarnings[0].details.taskIds.slice().sort(), ["cycle-a", "cycle-b"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("parentage is never inferred from adjacency: two roots with no parentAgentId stay roots", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID);

    // task-alpha and task-beta are adjacent in created_at and sequence, share turn pturn-1,
    // and task-alpha's taskId even appears inside a tool call's input -- none of that may
    // ever be read as a parent/child edge. Only an explicit parentAgentId may.
    const alpha = byTaskId(view, "task-alpha");
    const beta = byTaskId(view, "task-beta");

    assert.equal(alpha.parentTaskId, null);
    assert.equal(beta.parentTaskId, null);
    assert.equal(alpha.depth, 0);
    assert.equal(beta.depth, 0);
    assert.equal(view.counts.roots, 3);
    assert.equal(view.counts.withExplicitParent, 0);
    assert.equal(view.hierarchyAvailable, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("sibling numbering is deterministic across repeated calls", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const first = await client.listParticipants(TREE_THREAD_ID);
    const second = await client.listParticipants(TREE_THREAD_ID);

    const pathsOf = (view) => Object.fromEntries(
      view.participants.map((participant) => [participant.taskId, participant.path]),
    );
    assert.deepEqual(pathsOf(first), pathsOf(second));
  } finally {
    cleanupFixture(fixture);
  }
});

test("--tree nests resolved children while keeping every participant field", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID, { tree: true });

    assert.equal(view.participants.length, 2);
    const root = view.participants.find((participant) => participant.taskId === "root-task");
    const nullTime = view.participants.find((participant) => participant.taskId === "null-time-task");
    assert.ok(root);
    assert.ok(nullTime);

    assert.equal(root.children.length, 2);
    const child = root.children.find((participant) => participant.taskId === "child-task");
    assert.ok(child);
    assert.equal(child.children.length, 1);
    assert.equal(child.children[0].taskId, "grandchild-task");

    // Nested nodes still carry the full participant field set, not a stripped-down shape.
    for (const key of ["title", "role", "state", "usage", "turnIds", "path", "depth"]) {
      assert.ok(Object.hasOwn(child, key), `nested child missing "${key}"`);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("--tree on a thread with no explicit parentage returns every participant as a root with empty children", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(FLAT_THREAD_ID, { tree: true });

    assert.equal(view.participants.length, 3);
    for (const participant of view.participants) {
      assert.deepEqual(participant.children, []);
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("a flat listParticipants envelope validates against schemas/participants.v1.json", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a --tree listParticipants envelope validates against schemas/participants.v1.json", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID, { tree: true });
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a cycle demotes only its own members: a downstream non-member keeps its explicit parent", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(CYCLE_SCOPE_THREAD_ID);

    const a = byTaskId(view, "A");
    const b = byTaskId(view, "B");
    const c = byTaskId(view, "C");
    const d = byTaskId(view, "D");

    assert.equal(a.parentTaskId, null);
    assert.equal(a.path, null);
    assert.equal(b.parentTaskId, null);
    assert.equal(b.path, null);

    // C's parentAgentId is A, but C never leads back to itself, so it is downstream of the
    // cycle without being a member of it and keeps its explicit edge.
    assert.equal(c.parentTaskId, "A");
    assert.equal(c.depth, 1);
    assert.equal(c.path, null);

    assert.equal(d.parentTaskId, null);

    const cycleWarnings = view.warnings.filter((entry) => entry.code === "PARENT_CYCLE");
    assert.equal(cycleWarnings.length, 1);
    assert.deepEqual(cycleWarnings[0].details.taskIds, ["A", "B"]);

    assert.equal(view.counts.withExplicitParent, 1);
    assert.equal(view.hierarchyAvailable, true);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a self-parent is a one-node PARENT_CYCLE, not an UNRESOLVED_PARENT", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(SELF_PARENT_THREAD_ID);
    const self = byTaskId(view, "self-parent-task");

    assert.equal(self.parentTaskId, null);
    assert.equal(self.path, null);

    assert.equal(view.warnings.some((entry) => entry.code === "UNRESOLVED_PARENT"), false);
    const cycleWarnings = view.warnings.filter((entry) => entry.code === "PARENT_CYCLE");
    assert.equal(cycleWarnings.length, 1);
    assert.deepEqual(cycleWarnings[0].details.taskIds, ["self-parent-task"]);
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("usage is folded per field across activities, not replaced wholesale, for typedUsage and snake_case usage alike", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(USAGE_FOLD_THREAD_ID);

    const typed = byTaskId(view, "usage-fold-typed");
    assert.deepEqual(typed.usage, { totalTokens: 200, toolUses: 5, durationMs: 20 });

    const snake = byTaskId(view, "usage-fold-snake");
    assert.deepEqual(snake.usage, { totalTokens: 200, toolUses: 5, durationMs: 20 });
  } finally {
    cleanupFixture(fixture);
  }
});

test("typedUsage wins per field over usage even when usage was reported by a later activity", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(USAGE_FOLD_THREAD_ID);
    const mixed = byTaskId(view, "usage-fold-mixed");

    // usage (snake_case) reported totalTokens:50 first; typedUsage reported totalTokens:999
    // afterward. typedUsage wins regardless of which activity came later.
    assert.deepEqual(mixed.usage, { totalTokens: 999, toolUses: 1, durationMs: 10 });
  } finally {
    cleanupFixture(fixture);
  }
});

test("a wrong-typed scalar is routed to adapterSpecific instead of breaking the declared top-level type", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TYPE_COERCION_THREAD_ID);
    const wrongTyped = byTaskId(view, "wrong-typed-task");

    assert.equal(wrongTyped.status, "0");
    assert.equal(wrongTyped.title, null);
    assert.deepEqual(wrongTyped.adapterSpecific.title, { a: 1 });
    assert.equal(wrongTyped.isBackgrounded, null);
    assert.equal(wrongTyped.adapterSpecific.isBackgrounded, "yes");
    assertValidEnvelope(view);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a legitimate isBackgrounded: false is preserved as a real boolean, not swallowed as absent", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TYPE_COERCION_THREAD_ID);
    const boolFalse = byTaskId(view, "bool-false-task");

    assert.equal(boolFalse.isBackgrounded, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("a numeric taskId is emitted as a string, and a numeric parentAgentId still resolves against it", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TYPE_COERCION_THREAD_ID);

    const numericRoot = byTaskId(view, "42");
    assert.equal(numericRoot.taskId, "42");

    const numericChild = byTaskId(view, "numeric-id-child");
    assert.equal(numericChild.parentTaskId, "42");
  } finally {
    cleanupFixture(fixture);
  }
});

test("tree paging that excludes a resolved parent surfaces the child at the top level and emits PARENT_OUT_OF_PAGE", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const page = await client.listParticipants(TREE_THREAD_ID, { tree: true, limit: 1, offset: 1 });

    // Ascending order is root-task, child-task, grandchild-task, second-child-task,
    // null-time-task; offset 1 limit 1 selects only child-task, whose resolved parent
    // (root-task) falls outside the page.
    assert.equal(page.participants.length, 1);
    assert.equal(page.participants[0].taskId, "child-task");
    assert.deepEqual(page.participants[0].children, []);

    const outOfPageWarnings = page.warnings.filter((entry) => entry.code === "PARENT_OUT_OF_PAGE");
    assert.equal(outOfPageWarnings.length, 1);
    assert.deepEqual(outOfPageWarnings[0].details.taskIds, ["child-task"]);
  } finally {
    cleanupFixture(fixture);
  }
});

test("--tree without paging emits no PARENT_OUT_OF_PAGE warning", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const view = await client.listParticipants(TREE_THREAD_ID, { tree: true });

    assert.equal(view.warnings.some((entry) => entry.code === "PARENT_OUT_OF_PAGE"), false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("path assignment on a long explicit parent chain is iterative and does not overflow the stack", () => {
  // Built in-memory rather than through the SQLite fixture: path strings grow quadratically
  // by design, so this stays well under a size that would exhaust memory while still being
  // far deeper than any real call stack could recurse through.
  const chainLength = 1500;
  const activities = [];
  for (let index = 0; index <= chainLength; index += 1) {
    const payload = { taskId: `chain-${index}` };
    if (index > 0) {
      payload.parentAgentId = `chain-${index - 1}`;
    }
    activities.push({
      activity_id: `deep-${index}`,
      thread_id: "deep-chain-thread",
      turn_id: null,
      kind: "task.started",
      payload_json: JSON.stringify(payload),
      created_at: null,
      sequence: index,
    });
  }

  const view = normalizeParticipants(
    { activities, selection: null },
    {
      threadId: "deep-chain-thread",
      options: { reverse: false, tree: false, limit: null, offset: 0 },
    },
  );

  assert.equal(view.participants.length, chainLength + 1);
  const deepest = view.participants.find((participant) => participant.taskId === `chain-${chainLength}`);
  assert.ok(deepest, "expected the deepest chain participant to be present");
  assert.equal(deepest.depth, chainLength);
});

test("every fixture thread's envelope, flat and --tree, validates against schemas/participants.v1.json", async () => {
  const fixture = createParticipantFixture();
  try {
    const client = await createT3SessionClient({ db: fixture.databasePath });
    const threadIds = [
      FLAT_THREAD_ID,
      TREE_THREAD_ID,
      BROKEN_THREAD_ID,
      EMPTY_THREAD_ID,
      CYCLE_SCOPE_THREAD_ID,
      SELF_PARENT_THREAD_ID,
      USAGE_FOLD_THREAD_ID,
      TYPE_COERCION_THREAD_ID,
    ];

    for (const threadId of threadIds) {
      assertValidEnvelope(await client.listParticipants(threadId));
      assertValidEnvelope(await client.listParticipants(threadId, { tree: true }));
    }
  } finally {
    cleanupFixture(fixture);
  }
});
