import os from "node:os";
import path from "node:path";

import { ConfigurationError } from "./errors.js";

export const DEFAULT_T3_HOME = path.join(os.homedir(), ".t3");
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

function resolvePath(value, { cwd, homeDirectory }) {
  const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : value;
  return path.resolve(cwd, expanded);
}

function resolveConfiguredPath(value, label, options) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`${label} must be a non-empty path.`, { field: label });
  }

  return resolvePath(value, options);
}

export function resolveConfig({ home, db, env = process.env, cwd = process.cwd(), homeDirectory = os.homedir() } = {}) {
  const configuredHome = home === undefined ? env.T3_HOME : home;
  const homePath = configuredHome === undefined || configuredHome === ""
    ? resolvePath(path.join(homeDirectory, ".t3"), { cwd, homeDirectory })
    : resolveConfiguredPath(configuredHome, "home", { cwd, homeDirectory });
  const stateDb = db === undefined || db === ""
    ? path.join(homePath, "userdata", "state.sqlite")
    : resolveConfiguredPath(db, "db", { cwd, homeDirectory });
  const providerLogDirectory = path.join(homePath, "userdata", "logs", "provider");

  return Object.freeze({
    home: homePath,
    stateDb,
    providerLogDirectory,
  });
}

export function validateThreadId(threadId) {
  if (typeof threadId !== "string" || !SAFE_THREAD_ID.test(threadId) || hasControlCharacter(threadId)) {
    throw new ConfigurationError("threadId must be a non-empty path-safe value.", { field: "threadId" });
  }

  return threadId;
}

export function resolveProviderLogPath(config, threadId) {
  validateThreadId(threadId);
  return path.join(config.providerLogDirectory, `events.${threadId}.log`);
}
