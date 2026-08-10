import packageMetadata from "../package.json" with { type: "json" };

import { resolveConfig } from "./config.js";
import {
  InvalidArgumentsError,
  NotImplementedError,
  UnknownCommandError,
  toT3SessionError,
} from "./errors.js";

export const VERSION = packageMetadata.version;

const COMMANDS = ["get", "find", "doctor", "schema", "install"];
const STORAGE_COMMANDS = new Set(["get", "find", "doctor"]);

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

function requireOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new InvalidArgumentsError(`Missing value for ${option}.`, { option });
  }

  return value;
}

export function parseCliArgs(argv = []) {
  const result = {
    command: null,
    args: [],
    home: undefined,
    db: undefined,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      result.help = true;
      continue;
    }

    if (value === "--version" || value === "-v") {
      result.version = true;
      continue;
    }

    if (value === "--home") {
      result.home = requireOptionValue(argv, index, "--home");
      index += 1;
      continue;
    }

    if (value === "--db") {
      result.db = requireOptionValue(argv, index, "--db");
      index += 1;
      continue;
    }

    if (value === "--") {
      result.args.push(...argv.slice(index + 1));
      break;
    }

    if (result.command === null) {
      if (value.startsWith("-")) {
        throw new InvalidArgumentsError(`Unknown option: ${value}`, { option: value });
      }

      result.command = value;
      continue;
    }

    result.args.push(value);
  }

  return result;
}

export function formatHelp() {
  return [
    `t3-session ${VERSION}`,
    "",
    "Read-only access to local T3 Code conversation threads.",
    "",
    "Usage:",
    "  t3-session [options] <command> [args]",
    "  t3-session --help",
    "  t3-session --version",
    "",
    "Options:",
    "  --home <path>           Use a T3 home directory",
    "  --db <path>             Override the SQLite database path",
    "  -h, --help              Show this help",
    "  -v, --version           Show the package version",
    "",
    "Commands:",
    "  get <thread-id>         Retrieve one thread",
    "  find --title <text>     Find threads by title",
    "  doctor                  Check the local T3 installation",
    "  schema <name>           Print a bundled schema",
    "  install --skills <agent>",
    "                          Install the bundled recovery skill",
    "  help                    Show this help",
    "",
    "The retrieval commands are scaffolded in this release and do not access T3 storage yet.",
  ].join("\n");
}

async function notImplemented(options) {
  throw new NotImplementedError(options.command);
}

const commandHandlers = new Map(COMMANDS.map((command) => [command, notImplemented]));

export async function dispatchCommand(options) {
  if (options.command === "help") {
    return { help: true };
  }

  const handler = commandHandlers.get(options.command);
  if (!handler) {
    throw new UnknownCommandError(options.command);
  }

  return handler(options);
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;

  try {
    const options = parseCliArgs(argv);

    if (options.version) {
      writeLine(stdout, VERSION);
      return 0;
    }

    if (options.help || options.command === null || options.command === "help") {
      writeLine(stdout, formatHelp());
      return 0;
    }

    const config = STORAGE_COMMANDS.has(options.command) ? resolveConfig(options) : undefined;
    await dispatchCommand({ ...options, config });
    return 0;
  } catch (error) {
    const normalized = toT3SessionError(error);
    writeLine(stderr, `${normalized.code}: ${normalized.message}`);
    return normalized.exitCode;
  }
}
