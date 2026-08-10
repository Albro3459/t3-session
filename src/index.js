import packageMetadata from "../package.json" with { type: "json" };

import { resolveConfig } from "./config.js";
import { NotImplementedError } from "./errors.js";

export const VERSION = packageMetadata.version;

function unavailable(method) {
  throw new NotImplementedError(method);
}

export async function createT3SessionClient(options = {}) {
  const config = resolveConfig(options);

  return Object.freeze({
    config,
    async getThread(threadId, requestOptions = {}) {
      void threadId;
      void requestOptions;
      return unavailable("getThread");
    },
    async findThreads(requestOptions = {}) {
      void requestOptions;
      return unavailable("findThreads");
    },
    async readRawJsonl(threadId, requestOptions = {}) {
      void threadId;
      void requestOptions;
      return unavailable("readRawJsonl");
    },
    async doctor(requestOptions = {}) {
      void requestOptions;
      return unavailable("doctor");
    },
  });
}

export { resolveConfig } from "./config.js";
export {
  ConfigurationError,
  EXIT_CODES,
  InvalidArgumentsError,
  NotImplementedError,
  T3SessionError,
  UnknownCommandError,
  serializeError,
} from "./errors.js";
