import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createT3SessionClient, EXIT_CODES, ThreadNotFoundError } from "../src/index.js";
import {
  isTerminalTaskStatus,
  TASK_ACTIVITY_KINDS,
  TERMINAL_TASK_STATUSES,
} from "../src/participants.js";
import {
  BROKEN_THREAD_ID,
  createParticipantFixture,
  DELETED_THREAD_ID,
  EMPTY_THREAD_ID,
  FLAT_THREAD_ID,
  TREE_THREAD_ID,
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

// Recursively validates a participant (and, for --tree output, its nested children)
// against the schema's participant definition, the same way live-state.test.js and
// output-ordering.test.js hand-roll schema conformance without a JSON-schema dependency.
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
  assert.ok(
    participantSchema.properties.state.enum.includes(participant.state),
    `unexpected state "${participant.state}"`,
  );
  assert.equal(typeof participant.usage, "object");
  assert.ok(participant.usage !== null);

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
