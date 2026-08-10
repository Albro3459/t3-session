import fs from "node:fs";

import { ProviderLogUnavailableError } from "./errors.js";

const PREFIX_PATTERN = /^\[([^\]]+)\]\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u;
const PROVIDER_LABELS = new Set(["CANON", "NTIVE"]);

function createWarning(lineNumber, message, details = {}) {
  return {
    code: "MALFORMED_PROVIDER_JSONL_LINE",
    line: lineNumber,
    message,
    details,
  };
}

export function parseProviderJsonl(source, { path: sourcePath = null } = {}) {
  if (typeof source !== "string") {
    throw new TypeError("Provider JSONL source must be a string.");
  }

  const records = [];
  const warnings = [];
  const lines = source.split(/\r?\n/u);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (line.trim() === "") {
      warnings.push(createWarning(lineNumber, "Provider JSONL line is empty.", {
        path: sourcePath,
        reason: "empty-line",
      }));
      continue;
    }

    const match = PREFIX_PATTERN.exec(line);
    if (!match) {
      warnings.push(createWarning(lineNumber, "Provider JSONL line has an invalid prefix.", {
        path: sourcePath,
        reason: "invalid-prefix",
      }));
      continue;
    }

    const [, timestamp, label, jsonText] = match;
    if (!PROVIDER_LABELS.has(label)) {
      warnings.push(createWarning(lineNumber, `Unsupported provider JSONL label: ${label}.`, {
        path: sourcePath,
        label,
        reason: "unsupported-label",
      }));
      continue;
    }

    try {
      records.push({
        timestamp,
        label,
        data: JSON.parse(jsonText),
      });
    } catch (error) {
      warnings.push(createWarning(lineNumber, "Provider JSONL record contains malformed JSON.", {
        path: sourcePath,
        label,
        reason: "invalid-json",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  return { records, warnings };
}

export function readProviderJsonl(filePath, { threadId } = {}) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const reason = error?.code === "ENOENT" ? "missing" : "unreadable";
    throw new ProviderLogUnavailableError(threadId, filePath, reason, error);
  }

  return {
    path: filePath,
    ...parseProviderJsonl(source, { path: filePath }),
  };
}

export { PROVIDER_LABELS };
