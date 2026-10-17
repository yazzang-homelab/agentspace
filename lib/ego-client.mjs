// `globalThis.ego` for `agentspace run`: the native bindings documented in
// citrolabs/ego-lite docs/native-bindings-api.md, implemented as RPC calls to
// the local agentspace daemon.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

import { CODES } from "./errors.mjs";
import { ensureDir, servicePaths } from "./paths.mjs";
import { LineSocket } from "./wire.mjs";

const CLI_ENTRY = fileURLToPath(new URL("./cli.mjs", import.meta.url));

function invalidArgument(message) {
  const error = new TypeError(message);
  error.error_code = CODES.INVALID_ARGUMENT;
  return error;
}

function openSocket(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Connect to the daemon, starting it in the background when needed. */
export async function connectDaemon(instance) {
  const paths = servicePaths(instance);
  try {
    return await openSocket(paths.socketPath);
  } catch {}
  ensureDir(paths.dataDir);
  ensureDir(paths.runtimeDir);
  const log = openSync(paths.logFile, "a");
  const child = spawn(process.execPath, [CLI_ENTRY, "--instance", instance, "daemon"], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      return await openSocket(paths.socketPath);
    } catch (error) {
      lastError = error;
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(
    `Failed to start agentspace (${lastError?.message || "daemon exited"}). See ${paths.logFile}`,
  );
}

export class DaemonClient {
  #wire;
  #nextId = 1;
  #pending = new Map();
  #pendingCdp = new Set();
  #onCdp = () => {};
  #onCdpError = () => {};

  constructor(socket) {
    this.#wire = new LineSocket(socket);
    this.#wire.onMessage((message) => this.#onMessage(message));
    this.#wire.onClose(() => {
      for (const entry of this.#pending.values()) {
        entry.resolve({
          error: "agentspace closed the connection before the command finished. It may have quit or restarted; run the command again.",
          error_code: CODES.TASK_HOST_DISCONNECTED,
        });
      }
      this.#pending.clear();
      if (this.#pendingCdp.size > 0) {
        this.#pendingCdp.clear();
        this.#onCdpError("agentspace closed the CDP connection", CODES.TASK_HOST_DISCONNECTED);
      }
    });
    this.#updateRef();
  }

  static async connect(instance) {
    return new DaemonClient(await connectDaemon(instance));
  }

  get connected() {
    return !this.#wire.closed;
  }

  // Keep the process alive only while the daemon owes us a reply, so a
  // finished script exits through the normal beforeExit path.
  #updateRef() {
    if (this.#pending.size > 0 || this.#pendingCdp.size > 0) this.#wire.socket.ref();
    else this.#wire.socket.unref();
  }

  call(method, spaceId, args = []) {
    if (this.#wire.closed) {
      return Promise.resolve({
        error: "agentspace is not connected",
        error_code: CODES.TASK_HOST_DISCONNECTED,
      });
    }
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, { resolve });
      this.#wire.send({ op: "call", id, method, spaceId, args });
      this.#updateRef();
    });
  }

  sendCdp(spaceId, message, cdpId) {
    if (Number.isInteger(cdpId)) this.#pendingCdp.add(cdpId);
    this.#wire.send({ op: "cdp", spaceId, message });
    this.#updateRef();
  }

  setCdpHandlers(onMessage, onError) {
    this.#onCdp = onMessage;
    this.#onCdpError = onError;
  }

  close() {
    this.#wire.close();
  }

  #onMessage(message) {
    if (message.op === "cdp") {
      try {
        const parsed = JSON.parse(message.message);
        if (Object.hasOwn(parsed, "id") && !parsed.sessionId) this.#pendingCdp.delete(parsed.id);
        else if (Object.hasOwn(parsed, "id")) this.#pendingCdp.delete(parsed.id);
      } catch {}
      this.#updateRef();
      this.#onCdp(message.message);
      return;
    }
    if (message.op === "cdpError") {
      // A local send failure ends every outstanding command on this channel.
      this.#pendingCdp.clear();
      this.#updateRef();
      this.#onCdpError(message.message, message.error_code);
      return;
    }
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    entry.resolve(message.error ? { ...message.error, __egoError: true } : { value: message.result });
    this.#updateRef();
  }
}

/** Build the `ego` object for one Node invocation. */
export function createEgoBindings(client) {
  let selected;
  let onCDPMessage;
  let onSendCDPMessageError;

  client.setCdpHandlers(
    (message) => {
      const callback = onCDPMessage;
      if (typeof callback === "function") setImmediate(() => callback(message));
    },
    (message, errorCode) => {
      const callback = onSendCDPMessageError;
      if (typeof callback === "function") setImmediate(() => callback(message, errorCode));
    },
  );

  const unwrap = async (promise) => {
    const response = await promise;
    if (response.__egoError) {
      const { __egoError, ...error } = response;
      return error;
    }
    return response.value;
  };
  const task = (method, args = []) => unwrap(client.call(method, selected, args));
  const global = (method, args = []) => unwrap(client.call(method, undefined, args));
  const noArgs = (name, args) => {
    if (args.length > 0) throw invalidArgument(`ego.${name}() does not accept arguments`);
  };

  const ego = {
    getBrowserVersion() {
      return global("getBrowserVersion");
    },
    useTaskSpace(...args) {
      if (args.length !== 1 || typeof args[0] !== "number" || !Number.isFinite(args[0])) {
        throw invalidArgument("ego.useTaskSpace(id) requires exactly one numeric task-space id");
      }
      selected = args[0];
      return selected;
    },
    listProfiles(...args) {
      noArgs("listProfiles", args);
      return global("listProfiles");
    },
    createTab(...args) {
      if (args.length !== 1 || typeof args[0] !== "string") {
        throw invalidArgument("ego.createTab(url) requires a url string");
      }
      return task("createTab", args);
    },
    listTabs() {
      return task("listTabs");
    },
    snapshot(...args) {
      if (args.length > 1 || (args[0] !== undefined && (typeof args[0] !== "object" || args[0] === null || Array.isArray(args[0])))) {
        throw invalidArgument(
          "ego.snapshot(options?) expects an options object with scope 'only_within_viewport', 'full_page', or 'subtree'.",
        );
      }
      // Unlike the other bindings, snapshot rejects instead of resolving an error object.
      return task("snapshot", [args[0] ?? {}]).then((result) => {
        if (result && typeof result === "object" && "error" in result && "error_code" in result) {
          const error = new Error(result.error);
          error.error_code = result.error_code;
          throw error;
        }
        return result;
      });
    },
    listTaskSpaces() {
      return global("listTaskSpaces");
    },
    createTaskSpace(...args) {
      if (args.length < 1 || args.length > 2 || typeof args[0] !== "string" || args[0].length === 0) {
        throw invalidArgument("ego.createTaskSpace(name, profileId?) requires a non-empty name string");
      }
      if (args.length === 2 && args[1] !== undefined && typeof args[1] !== "string") {
        throw invalidArgument("ego.createTaskSpace(name, profileId?) profileId must be a string");
      }
      return global("createTaskSpace", args);
    },
    claimTaskSpace(...args) {
      if (args.length < 1 || args.length > 2 || typeof args[0] !== "number") {
        throw invalidArgument("ego.claimTaskSpace(id, name?) requires a numeric id");
      }
      if (args.length === 2 && args[1] !== undefined && typeof args[1] !== "string") {
        throw invalidArgument("ego.claimTaskSpace(id, name?) name must be a string");
      }
      return global("claimTaskSpace", args);
    },
    closeTaskSpace(...args) {
      noArgs("closeTaskSpace", args);
      return task("closeTaskSpace");
    },
    completeTaskSpace(...args) {
      noArgs("completeTaskSpace", args);
      return task("completeTaskSpace");
    },
    handOffTaskSpace(...args) {
      noArgs("handOffTaskSpace", args);
      return task("handOffTaskSpace");
    },
    takeOverTaskSpace(...args) {
      noArgs("takeOverTaskSpace", args);
      return task("takeOverTaskSpace");
    },
    setAgentTaskState(...args) {
      if (args.length !== 1 || typeof args[0] !== "string") {
        throw invalidArgument("ego.setAgentTaskState(state) requires a string");
      }
      return task("setAgentTaskState", args);
    },
    animationHighlightMouseToPosition(...args) {
      if (args.length !== 2 || typeof args[0] !== "number" || typeof args[1] !== "number") {
        throw invalidArgument("ego.animationHighlightMouseToPosition(x, y) requires two numbers");
      }
      return task("animationHighlightMouseToPosition", args);
    },
    // Linux extension used by the patched SDK for page.keyboard.paste.
    beginClipboardTransaction(...args) {
      const content = args[0];
      if (args.length !== 1 || !content || typeof content.text !== "string") {
        throw invalidArgument("ego.beginClipboardTransaction(content) requires { text, html? }");
      }
      return task("beginClipboardTransaction", args);
    },
    finishClipboardTransaction(...args) {
      if (args.length !== 1 || typeof args[0] !== "string") {
        throw invalidArgument("ego.finishClipboardTransaction(transactionId) requires a string id");
      }
      return task("finishClipboardTransaction", args);
    },
    sendCDPMessage(...args) {
      if (args.length !== 1 || typeof args[0] !== "string") {
        throw invalidArgument("ego.sendCDPMessage(message) requires a JSON string");
      }
      if (!client.connected) {
        const error = new TypeError("CDP channel is not connected");
        error.error_code = CODES.CDP_CHANNEL_UNAVAILABLE;
        throw error;
      }
      if (selected === undefined) {
        const callback = onSendCDPMessageError;
        if (typeof callback === "function") {
          setImmediate(() => callback("Task space not selected", CODES.TASK_SPACE_NOT_SELECTED));
        }
        return undefined;
      }
      let cdpId;
      try {
        cdpId = JSON.parse(args[0]).id;
      } catch {}
      client.sendCdp(selected, args[0], cdpId);
      return undefined;
    },
  };
  Object.defineProperty(ego, "onCDPMessage", {
    enumerable: false,
    configurable: false,
    get: () => onCDPMessage,
    set: (value) => {
      onCDPMessage = typeof value === "function" ? value : undefined;
    },
  });
  Object.defineProperty(ego, "onSendCDPMessageError", {
    enumerable: false,
    configurable: false,
    get: () => onSendCDPMessageError,
    set: (value) => {
      onSendCDPMessageError = typeof value === "function" ? value : undefined;
    },
  });
  return ego;
}
