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

  lines.push("", "Turns", "-----");
  if (thread.turns.length === 0) {
    lines.push("- None");
  } else {
    for (const turn of thread.turns) {
      const state = turn.state || "unknown state";
      const timing = turn.completedAt || turn.startedAt || turn.requestedAt || "unknown time";
      lines.push(`- ${turn.turnId || "unknown turn"} [${state}] ${timing}`);
    }
  }

  lines.push("", "Messages", "--------");
  if (thread.messages.length === 0) {
    lines.push("- None");
  } else {
    for (const message of thread.messages) {
      lines.push(...formatMessage(message));
    }
  }

  lines.push("", "Activities", "----------");
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

export function jsonlRecordsForThread(thread) {
  const threadId = thread.thread.id;
  return [
    {
      ...createRecord("thread", threadId, thread.thread),
      provider: thread.provider,
      warnings: thread.warnings,
    },
    ...thread.turns.map((turn) => createRecord("turn", threadId, turn)),
    ...thread.messages.map((message) => createRecord("message", threadId, message)),
    ...thread.activities.map((activity) => createRecord("activity", threadId, activity)),
  ];
}

export function formatThreadJsonl(thread) {
  return `${jsonlRecordsForThread(thread).map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export { JSONL_SCHEMA_VERSION };
