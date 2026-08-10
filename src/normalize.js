const SCHEMA_VERSION = "t3-session.thread.v1";

function warningFor(field, raw, error) {
  return {
    code: "MALFORMED_JSON",
    field,
    message: `Unable to parse ${field} as JSON.`,
    details: {
      raw,
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

export function parseJsonField(raw, field, warnings) {
  if (raw === null || raw === undefined) {
    return { value: raw === undefined ? null : raw, malformed: false };
  }

  if (typeof raw !== "string") {
    return { value: raw, malformed: false };
  }

  try {
    return { value: JSON.parse(raw), malformed: false };
  } catch (error) {
    warnings.push(warningFor(field, raw, error));
    return { value: null, malformed: true, raw };
  }
}

function addAdapterSpecific(target, values) {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length > 0) {
    target.adapterSpecific = Object.fromEntries(entries);
  }
  return target;
}

function normalizeBoolean(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value === true || value === false) return value;
  return value === 1 || value === "1" || value === "true";
}

function normalizeThreadMetadata(row) {
  const hasJoinMarker = Object.hasOwn(row, "project_join_id");
  const projectPresent = hasJoinMarker
    ? row.project_join_id !== null && row.project_join_id !== undefined
    : row.project_title !== null || row.workspace_root !== null;
  const project = !projectPresent
    ? null
    : {
        title: row.project_title ?? null,
        workspaceRoot: row.workspace_root ?? null,
      };

  return {
    id: row.thread_id,
    projectId: row.project_id ?? null,
    title: row.title ?? null,
    project,
    branch: row.branch ?? null,
    worktreePath: row.worktree_path ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    latestTurnId: row.latest_turn_id ?? null,
    latestUserMessageAt: row.latest_user_message_at ?? null,
    runtimeMode: row.runtime_mode ?? null,
    interactionMode: row.interaction_mode ?? null,
    modelSelection: row.modelSelection,
    workspaceRoot: row.workspace_root ?? null,
  };
}

function normalizeTurn(row, warnings) {
  const checkpointFiles = parseJsonField(
    row.checkpoint_files_json,
    `turns.${row.turn_id ?? row.row_id}.checkpointFiles`,
    warnings,
  );
  const normalized = {
    rowId: row.row_id ?? null,
    threadId: row.thread_id ?? null,
    turnId: row.turn_id ?? null,
    pendingMessageId: row.pending_message_id ?? null,
    sourceProposedPlanThreadId: row.source_proposed_plan_thread_id ?? null,
    sourceProposedPlanId: row.source_proposed_plan_id ?? null,
    assistantMessageId: row.assistant_message_id ?? null,
    state: row.state ?? null,
    requestedAt: row.requested_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    checkpointTurnCount: row.checkpoint_turn_count ?? null,
    checkpointRef: row.checkpoint_ref ?? null,
    checkpointStatus: row.checkpoint_status ?? null,
    checkpointFiles: checkpointFiles.value,
  };
  return addAdapterSpecific(normalized, checkpointFiles.malformed
    ? { checkpointFilesJson: checkpointFiles.raw }
    : {});
}

function normalizeMessage(row, warnings) {
  const attachments = parseJsonField(
    row.attachments_json,
    `messages.${row.message_id}.attachments`,
    warnings,
  );
  const normalized = {
    messageId: row.message_id,
    threadId: row.thread_id ?? null,
    turnId: row.turn_id ?? null,
    role: row.role ?? null,
    text: row.text ?? null,
    isStreaming: normalizeBoolean(row.is_streaming),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    attachments: attachments.value,
  };
  return addAdapterSpecific(normalized, attachments.malformed
    ? { attachmentsJson: attachments.raw }
    : {});
}

function normalizeActivity(row, warnings) {
  const payload = parseJsonField(
    row.payload_json,
    `activities.${row.activity_id}.payload`,
    warnings,
  );
  const normalized = {
    activityId: row.activity_id,
    threadId: row.thread_id ?? null,
    turnId: row.turn_id ?? null,
    tone: row.tone ?? null,
    kind: row.kind ?? null,
    summary: row.summary ?? null,
    payload: payload.value,
    createdAt: row.created_at ?? null,
    sequence: row.sequence ?? null,
  };
  return addAdapterSpecific(normalized, payload.malformed
    ? { payloadJson: payload.raw }
    : {});
}

function normalizeProvider(row) {
  return {
    providerName: row?.provider_name ?? null,
    providerSessionId: row?.provider_session_id ?? null,
    providerThreadId: row?.provider_thread_id ?? null,
    providerInstanceId: row?.provider_instance_id ?? null,
    status: row?.status ?? null,
    lastError: row?.last_error ?? null,
    activeTurnId: row?.active_turn_id ?? null,
    runtimeMode: row?.runtime_mode ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export function normalizeThreadSearchResult(row) {
  const project = row.project_join_id === null || row.project_join_id === undefined
    ? null
    : {
        title: row.project_title ?? null,
        workspaceRoot: row.workspace_root ?? null,
      };

  return {
    id: row.thread_id,
    projectId: row.project_id ?? null,
    title: row.title ?? null,
    project,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export function normalizeThread(rows, { toolVersion = "0.1.0" } = {}) {
  const warnings = [];
  const modelSelection = parseJsonField(
    rows.thread.model_selection_json,
    "thread.modelSelection",
    warnings,
  );
  const thread = normalizeThreadMetadata({
    ...rows.thread,
    modelSelection: modelSelection.value,
  });
  if (modelSelection.malformed) {
    addAdapterSpecific(thread, { modelSelectionJson: modelSelection.raw });
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion,
    thread,
    turns: rows.turns.map((row) => normalizeTurn(row, warnings)),
    messages: rows.messages.map((row) => normalizeMessage(row, warnings)),
    activities: rows.activities.map((row) => normalizeActivity(row, warnings)),
    provider: normalizeProvider(rows.provider),
    warnings,
  };
}

export { SCHEMA_VERSION };
