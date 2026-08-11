const JSONL_SCHEMA_VERSION = "t3-session.jsonl-record.v1";

function displayValue(value) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value);
}

function addField(lines, label, value) {
  lines.push(`${label}: ${displayValue(value)}`);
}

function sectionHeading(title) {
  return [title, "-".repeat(title.length)];
}

function formatMessage(message) {
  const timestamp = message.createdAt || message.updatedAt || "unknown time";
  const role = message.role || "unknown role";
  const turn = message.turnId ? ` [${message.turnId}]` : "";
  const text = message.text ?? "";
  const textLines = String(text).split("\n");
  const lines = [`[${timestamp}] ${role}${turn}`];
  lines.push(...textLines.map((line) => `  ${line}`));
  return lines;
}

function formatActivity(activity) {
  const timestamp = activity.createdAt || "unknown time";
  const tone = activity.tone ? ` [${activity.tone}]` : "";
  const kind = activity.kind || "activity";
  const turn = activity.turnId ? ` (${activity.turnId})` : "";
  return `- [${timestamp}]${tone} ${kind}${turn}: ${activity.summary ?? ""}`;
}

export function formatThreadHuman(thread) {
  const bounded = thread.selection != null;
  const lines = ["Thread", "======", ""];
  addField(lines, "ID", thread.thread.id);
  addField(lines, "Title", thread.thread.title);
  addField(lines, "Project ID", thread.thread.projectId);
  addField(lines, "Project", thread.thread.project?.title);
  addField(lines, "Workspace root", thread.thread.workspaceRoot);
  addField(lines, "Branch", thread.thread.branch);
  addField(lines, "Worktree", thread.thread.worktreePath);
  addField(lines, "Created", thread.thread.createdAt);
  addField(lines, "Updated", thread.thread.updatedAt);
  addField(lines, "Latest user message", thread.thread.latestUserMessageAt);
  addField(lines, "Latest turn", thread.thread.latestTurnId);
  addField(lines, "Runtime mode", thread.thread.runtimeMode);
  addField(lines, "Interaction mode", thread.thread.interactionMode);
  addField(lines, "Model selection", thread.thread.modelSelection);

  lines.push("", "Provider", "--------");
  addField(lines, "Name", thread.provider.providerName);
  addField(lines, "Session ID", thread.provider.providerSessionId);
  addField(lines, "Thread ID", thread.provider.providerThreadId);
  addField(lines, "Instance ID", thread.provider.providerInstanceId);
  addField(lines, "Status", thread.provider.status);
  addField(lines, "Last error", thread.provider.lastError);

  if (bounded) {
    lines.push("", "Selection", "---------");
    addField(lines, "Kind", thread.selection.kind);
    addField(lines, "Turn ID", thread.selection.turnId);
    addField(lines, "Turn limit", thread.selection.turnLimit);
    addField(lines, "Turn offset", thread.selection.turnOffset);
    addField(lines, "Total turns", thread.selection.totalTurns);
    addField(lines, "Selected turns", thread.selection.selectedTurnIds.join(", "));
    lines.push("Partial history: yes");
  }

  lines.push("", ...sectionHeading(bounded ? "Turns (partial)" : "Turns"));
  if (thread.turns.length === 0) {
    lines.push("- None");
  } else {
    for (const turn of thread.turns) {
      const state = turn.state || "unknown state";
      const timing = turn.completedAt || turn.startedAt || turn.requestedAt || "unknown time";
      lines.push(`- ${turn.turnId || "unknown turn"} [${state}] ${timing}`);
    }
  }

  lines.push("", ...sectionHeading(bounded ? "Messages (partial)" : "Messages"));
  if (thread.messages.length === 0) {
    lines.push("- None");
  } else {
    for (const message of thread.messages) {
      lines.push(...formatMessage(message));
    }
  }

  lines.push("", ...sectionHeading(bounded ? "Activities (partial)" : "Activities"));
  if (thread.activities.length === 0) {
    lines.push("- None");
  } else {
    lines.push(...thread.activities.map(formatActivity));
  }

  if (thread.warnings.length > 0) {
    lines.push("", "Warnings", "--------");
    for (const warning of thread.warnings) {
      lines.push(`- ${warning.code}: ${warning.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatThreadJson(thread) {
  return `${JSON.stringify(thread, null, 2)}\n`;
}

export function formatFindJson(matches) {
  return `${JSON.stringify(matches, null, 2)}\n`;
}

export function formatFindHuman(matches, title) {
  const lines = ["Threads", "=======", "", `Title: ${title?.trim() || "-"}`, ""];
  if (matches.length === 0) {
    lines.push("No matching threads.");
    return `${lines.join("\n")}\n`;
  }

  for (const match of matches) {
    lines.push(
      `${match.title || "(untitled)"}`,
      `  ID: ${match.id}`,
      `  Project: ${match.project?.title || "-"}`,
      `  Updated: ${match.updatedAt || "-"}`,
      `  Created: ${match.createdAt || "-"}`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function formatListJson(list) {
  return `${JSON.stringify(list, null, 2)}\n`;
}

export function formatListHuman(list) {
  const lines = ["Threads", "=======", ""];
  addField(lines, "Project", list.filters.project);
  addField(lines, "Since", list.filters.since);
  addField(lines, "Before", list.filters.before);
  lines.push(`Order: ${list.ordering.sortBy} ${list.ordering.direction}`);
  addField(lines, "Limit", list.limit);
  addField(lines, "Offset", list.offset);
  addField(lines, "Returned", list.count);
  lines.push(`More available: ${list.hasMore ? "yes" : "no"}`, "");

  if (list.threads.length === 0) {
    lines.push("No matching threads.");
    return `${lines.join("\n")}\n`;
  }

  for (const thread of list.threads) {
    lines.push(
      `${thread.title || "(untitled)"}`,
      `  ID: ${thread.id}`,
      `  Project: ${thread.project?.title || "-"}`,
      `  Updated: ${thread.updatedAt || "-"}`,
      `  Created: ${thread.createdAt || "-"}`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function formatDoctorJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function createRecord(type, threadId, data) {
  return {
    schemaVersion: JSONL_SCHEMA_VERSION,
    recordType: type,
    threadId,
    data,
  };
}

const RECORD_TYPE_RANK = { turn: 0, message: 1, activity: 2 };

function turnEventTimestamp(turn) {
  return turn.requestedAt ?? turn.startedAt ?? turn.completedAt ?? null;
}

function messageEventTimestamp(message) {
  return message.createdAt ?? message.updatedAt ?? null;
}

function activityEventTimestamp(activity) {
  return activity.createdAt ?? null;
}

function buildSortableEntry(type, record) {
  if (type === "turn") {
    return {
      type,
      record,
      timestamp: turnEventTimestamp(record),
      secondary: record.rowId ?? null,
      identifier: record.turnId ?? String(record.rowId ?? ""),
    };
  }

  if (type === "message") {
    return {
      type,
      record,
      timestamp: messageEventTimestamp(record),
      secondary: null,
      identifier: record.messageId ?? "",
    };
  }

  return {
    type,
    record,
    timestamp: activityEventTimestamp(record),
    secondary: record.sequence ?? null,
    identifier: record.activityId ?? "",
  };
}

// Records with no event timestamp sort after every timestamped record; ties
// are broken by type rank (turn, then message, then activity), then by each
// type's numeric secondary key (rowId/sequence, nulls last), then by the
// type's stable identifier string.
function compareSortableEntries(a, b) {
  if (a.timestamp === null && b.timestamp !== null) return 1;
  if (a.timestamp !== null && b.timestamp === null) return -1;
  if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
    return a.timestamp < b.timestamp ? -1 : 1;
  }

  if (RECORD_TYPE_RANK[a.type] !== RECORD_TYPE_RANK[b.type]) {
    return RECORD_TYPE_RANK[a.type] - RECORD_TYPE_RANK[b.type];
  }

  if (a.secondary !== b.secondary) {
    if (a.secondary === null || a.secondary === undefined) return 1;
    if (b.secondary === null || b.secondary === undefined) return -1;
    return a.secondary - b.secondary;
  }

  if (a.identifier < b.identifier) return -1;
  if (a.identifier > b.identifier) return 1;
  return 0;
}

export function jsonlRecordsForThread(thread) {
  const threadId = thread.thread.id;
  const header = {
    ...createRecord("thread", threadId, thread.thread),
    provider: thread.provider,
    warnings: thread.warnings,
  };

  const entries = [
    ...thread.turns.map((turn) => buildSortableEntry("turn", turn)),
    ...thread.messages.map((message) => buildSortableEntry("message", message)),
    ...thread.activities.map((activity) => buildSortableEntry("activity", activity)),
  ];
  entries.sort(compareSortableEntries);

  return [
    header,
    ...entries.map((entry) => createRecord(entry.type, threadId, entry.record)),
  ];
}

export function formatThreadJsonl(thread) {
  return `${jsonlRecordsForThread(thread).map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function formatListJsonl(list) {
  const header = createRecord("list", null, {
    filters: list.filters,
    ordering: list.ordering,
    limit: list.limit,
    offset: list.offset,
    count: list.count,
    hasMore: list.hasMore,
  });
  const records = [
    header,
    ...list.threads.map((summary) => createRecord("thread", summary.id, summary)),
  ];

  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function formatRawJsonl(records) {
  return records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export { JSONL_SCHEMA_VERSION };
