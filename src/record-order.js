export const RECORD_TYPE_RANK = Object.freeze({ turn: 0, message: 1, activity: 2 });

function turnEventTimestamp(turn) {
  return turn.requestedAt ?? turn.startedAt ?? turn.completedAt ?? null;
}

function messageEventTimestamp(message) {
  return message.createdAt ?? message.updatedAt ?? null;
}

function activityEventTimestamp(activity) {
  return activity.createdAt ?? null;
}

export function buildSortableEntry(type, record) {
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
export function compareSortableEntries(a, b) {
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

// Shared by normalized JSONL output and by tail cycles so the two cannot drift.
export function chronologicalThreadEntries(thread) {
  const entries = [
    ...thread.turns.map((turn) => buildSortableEntry("turn", turn)),
    ...thread.messages.map((message) => buildSortableEntry("message", message)),
    ...thread.activities.map((activity) => buildSortableEntry("activity", activity)),
  ];
  entries.sort(compareSortableEntries);
  return entries;
}
