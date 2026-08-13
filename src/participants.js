import { parseJsonField } from "./normalize.js";

export const PARTICIPANTS_SCHEMA_VERSION = "t3-session.participants.v1";

export const TASK_ACTIVITY_KINDS = Object.freeze([
  "task.started",
  "task.progress",
  "task.completed",
  "task.updated",
]);

// A status outside this set is treated as non-terminal, because reporting a still-running
// agent as finished is the more damaging error.
export const TERMINAL_TASK_STATUSES = Object.freeze([
  "cancelled",
  "completed",
  "failed",
  "stopped",
]);

const TERMINAL_TASK_STATUS_SET = new Set(TERMINAL_TASK_STATUSES);

// Folded onto the participant as last-non-null-wins scalars. Everything else the projection
// carries lands in adapterSpecific instead of inventing top-level fields.
const SCALAR_FIELDS = Object.freeze([
  "title",
  "role",
  "model",
  "agentKind",
  "taskType",
  "effort",
  "status",
  "summary",
  "detail",
  "error",
  "toolUseId",
  "lastToolName",
  "workflowName",
  "outputFile",
  "isBackgrounded",
]);

const CONSUMED_KEYS = new Set([...SCALAR_FIELDS, "taskId", "parentAgentId", "usage", "typedUsage"]);

export function isTerminalTaskStatus(status) {
  return typeof status === "string" && TERMINAL_TASK_STATUS_SET.has(status.trim().toLowerCase());
}

function taskState(status, hasStatusField) {
  if (!hasStatusField) return "unknown";
  return isTerminalTaskStatus(status) ? "finished" : "running";
}

// Unknown usage values stay null rather than becoming 0, so "not reported" and "zero" stay
// distinguishable.
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUsage(typedUsage, usage) {
  const typed = typedUsage && typeof typedUsage === "object" ? typedUsage : null;
  const raw = usage && typeof usage === "object" ? usage : null;

  return {
    totalTokens: numberOrNull(typed?.totalTokens) ?? numberOrNull(raw?.total_tokens),
    toolUses: numberOrNull(typed?.toolUses) ?? numberOrNull(raw?.tool_uses),
    durationMs: numberOrNull(typed?.durationMs) ?? numberOrNull(raw?.duration_ms),
  };
}

// Null created_at sorts last, matching the Increment 1 ordering rule.
function compareActivityRows(a, b) {
  const left = a.created_at ?? null;
  const right = b.created_at ?? null;
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;
  if (left !== null && right !== null && left !== right) return left < right ? -1 : 1;

  const leftSequence = a.sequence ?? null;
  const rightSequence = b.sequence ?? null;
  if (leftSequence !== rightSequence) {
    if (leftSequence === null) return 1;
    if (rightSequence === null) return -1;
    return leftSequence - rightSequence;
  }

  const leftId = a.activity_id ?? "";
  const rightId = b.activity_id ?? "";
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

// Direction-aware so a reversed listing cannot flip null firstSeenAt to the front: the
// Increment 1 rule is that a null ordering timestamp sorts last in both directions.
function compareParticipants(a, b, reverse = false) {
  const left = a.firstSeenAt ?? null;
  const right = b.firstSeenAt ?? null;
  if (left === null && right !== null) return 1;
  if (left !== null && right === null) return -1;

  const flip = reverse ? -1 : 1;
  if (left !== null && right !== null && left !== right) {
    return (left < right ? -1 : 1) * flip;
  }
  if (a.taskId === b.taskId) return 0;
  return (a.taskId < b.taskId ? -1 : 1) * flip;
}

function alphabeticLabel(index) {
  let remaining = index;
  let label = "";
  do {
    label = String.fromCharCode(97 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

// Roots are numbered, their children lettered, and the pattern alternates by depth, so a
// path reads main.subagent1.subagent1a.subagent1a1.
function siblingSuffix(depth, index) {
  return depth % 2 === 0 ? String(index + 1) : alphabeticLabel(index);
}

function foldActivities(taskId, rows) {
  const participant = {
    taskId,
    parentTaskId: null,
    path: null,
    depth: 0,
  };
  for (const field of SCALAR_FIELDS) {
    participant[field] = null;
  }

  const turnIds = new Set();
  const adapterSpecific = {};
  let parentAgentId = null;
  let hasStatusField = false;
  let typedUsage = null;
  let usage = null;
  let firstSeenAt = null;
  let lastSeenAt = null;
  let turnId = null;

  for (const { row, payload } of rows) {
    if (row.turn_id !== null && row.turn_id !== undefined) {
      turnIds.add(row.turn_id);
      if (turnId === null) {
        turnId = row.turn_id;
      }
    }
    if (row.created_at !== null && row.created_at !== undefined) {
      if (firstSeenAt === null) firstSeenAt = row.created_at;
      lastSeenAt = row.created_at;
    }

    if (!payload || typeof payload !== "object") {
      continue;
    }

    for (const field of SCALAR_FIELDS) {
      const value = payload[field];
      if (value !== undefined && value !== null) {
        participant[field] = value;
        if (field === "status") hasStatusField = true;
      }
    }

    if (payload.parentAgentId !== undefined && payload.parentAgentId !== null) {
      parentAgentId = payload.parentAgentId;
    }
    if (payload.typedUsage !== undefined && payload.typedUsage !== null) {
      typedUsage = payload.typedUsage;
    }
    if (payload.usage !== undefined && payload.usage !== null) {
      usage = payload.usage;
    }

    for (const [key, value] of Object.entries(payload)) {
      if (!CONSUMED_KEYS.has(key) && value !== undefined && value !== null) {
        adapterSpecific[key] = value;
      }
    }
  }

  participant.state = taskState(participant.status, hasStatusField);
  participant.turnId = turnId;
  participant.turnIds = [...turnIds].sort();
  participant.firstSeenAt = firstSeenAt;
  participant.lastSeenAt = lastSeenAt;
  participant.activityCount = rows.length;
  participant.usage = normalizeUsage(typedUsage, usage);

  if (Object.keys(adapterSpecific).length > 0) {
    participant.adapterSpecific = adapterSpecific;
  }

  return { participant, parentAgentId };
}

// Parentage comes only from an explicit, resolvable parentAgentId. Nothing here looks at
// timestamps, activity order, sequence, toolUseId, or identifier shape: two tasks that merely
// ran next to each other are two roots, and that is the correct answer.
function resolveHierarchy(entries, warnings) {
  const byTaskId = new Map(entries.map((entry) => [entry.participant.taskId, entry]));

  for (const entry of entries) {
    const { participant, parentAgentId } = entry;
    if (parentAgentId === null || parentAgentId === undefined) {
      continue;
    }

    if (parentAgentId === participant.taskId || !byTaskId.has(parentAgentId)) {
      warnings.push({
        code: "UNRESOLVED_PARENT",
        message: "A task recorded a parent that does not resolve to a known participant.",
        details: { taskId: participant.taskId, parentAgentId },
      });
      entry.unresolvedParent = true;
      continue;
    }

    participant.parentTaskId = parentAgentId;
  }

  // Walk each participant's ancestry; anything that fails to reach a root within the number
  // of participants is inside a cycle and is demoted to a root instead of hanging.
  const inCycle = new Set();
  for (const entry of entries) {
    const seen = new Set([entry.participant.taskId]);
    let current = entry.participant.parentTaskId;
    while (current !== null) {
      if (seen.has(current)) {
        inCycle.add(entry.participant.taskId);
        break;
      }
      seen.add(current);
      current = byTaskId.get(current)?.participant.parentTaskId ?? null;
    }
  }

  if (inCycle.size > 0) {
    warnings.push({
      code: "PARENT_CYCLE",
      message: "Recorded task parentage contains a cycle; the affected tasks are reported as roots.",
      details: { taskIds: [...inCycle].sort() },
    });
    for (const taskId of inCycle) {
      byTaskId.get(taskId).participant.parentTaskId = null;
      byTaskId.get(taskId).cycleMember = true;
    }
  }

  return byTaskId;
}

function assignPathsAndDepths(entries) {
  const children = new Map();
  const roots = [];

  for (const entry of entries) {
    const parentTaskId = entry.participant.parentTaskId;
    if (parentTaskId === null) {
      roots.push(entry);
      continue;
    }
    if (!children.has(parentTaskId)) {
      children.set(parentTaskId, []);
    }
    children.get(parentTaskId).push(entry);
  }

  // Each label extends its parent's, and the path is every ancestor label under a synthetic
  // "main" root. ancestryKnown carries down the tree: an unresolved or cyclic ancestor makes
  // every descendant's position unknown too, so none of them get a path.
  const walk = (entry, depth, label, ancestorSegments, ancestryKnown) => {
    const known = ancestryKnown && !entry.unresolvedParent && !entry.cycleMember;
    const segments = [...ancestorSegments, label];
    entry.participant.depth = depth;
    entry.participant.path = known ? ["main", ...segments].join(".") : null;

    const ownChildren = children.get(entry.participant.taskId) || [];
    ownChildren.sort((a, b) => compareParticipants(a.participant, b.participant));
    ownChildren.forEach((child, index) => {
      walk(child, depth + 1, `${label}${siblingSuffix(depth + 1, index)}`, segments, known);
    });
  };

  roots.sort((a, b) => compareParticipants(a.participant, b.participant));
  roots.forEach((entry, index) => {
    walk(entry, 0, `subagent${siblingSuffix(0, index)}`, [], true);
  });

  return roots;
}

export function buildParticipantTree(participants) {
  const nodes = new Map(
    participants.map((participant) => [participant.taskId, { ...participant, children: [] }]),
  );
  const roots = [];

  for (const participant of participants) {
    const node = nodes.get(participant.taskId);
    const parent = participant.parentTaskId === null
      ? null
      : nodes.get(participant.parentTaskId) ?? null;
    // A child whose parent fell outside the selected page is surfaced at the root rather
    // than dropped; its parentTaskId still records the truth.
    if (parent === null) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  return roots;
}

export function normalizeParticipants(rows, {
  toolVersion = "0.1.0",
  threadId,
  options,
} = {}) {
  const warnings = [];
  const grouped = new Map();

  const activityRows = [...rows.activities].sort(compareActivityRows);
  for (const row of activityRows) {
    const parsed = parseJsonField(
      row.payload_json,
      `participants.${row.activity_id}.payload`,
      warnings,
    );
    const payload = parsed.value;
    const taskId = payload && typeof payload === "object" ? payload.taskId : null;
    if (taskId === null || taskId === undefined || taskId === "") {
      continue;
    }
    if (!grouped.has(taskId)) {
      grouped.set(taskId, []);
    }
    grouped.get(taskId).push({ row, payload });
  }

  const entries = [...grouped].map(([taskId, taskRows]) => foldActivities(taskId, taskRows));
  resolveHierarchy(entries, warnings);
  assignPathsAndDepths(entries);

  // Sibling labels above are always assigned in ascending order, so --reverse changes the
  // display order without renumbering any path.
  const ordered = entries
    .map((entry) => entry.participant)
    .sort((a, b) => compareParticipants(a, b, options.reverse));

  const total = ordered.length;
  const withExplicitParent = ordered.filter((p) => p.parentTaskId !== null).length;
  const unresolvedParents = warnings.filter((w) => w.code === "UNRESOLVED_PARENT").length;
  const offset = options.offset ?? 0;
  const selected = options.limit === null || options.limit === undefined
    ? ordered.slice(offset)
    : ordered.slice(offset, offset + options.limit);

  return {
    schemaVersion: PARTICIPANTS_SCHEMA_VERSION,
    toolVersion,
    threadId,
    ordering: { sortBy: "firstSeenAt", direction: options.reverse ? "desc" : "asc" },
    selection: rows.selection ?? null,
    counts: {
      total,
      participants: selected.length,
      roots: ordered.filter((p) => p.parentTaskId === null).length,
      withExplicitParent,
      unresolvedParents,
    },
    // Only true when a real edge resolved, so a consumer never presents a flat list as a tree.
    hierarchyAvailable: withExplicitParent > 0,
    participants: options.tree ? buildParticipantTree(selected) : selected,
    warnings,
  };
}
