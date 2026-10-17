import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SERVER_NAME = "default";
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function validServerName(name) {
  return typeof name === "string" && SERVER_NAME_PATTERN.test(name);
}

function xdg(variable, fallback) {
  const value = process.env[variable];
  return value && value.startsWith("/") ? value : join(homedir(), fallback);
}

/** Every path one named browser service owns. */
export function servicePaths(serverName = DEFAULT_SERVER_NAME) {
  if (!validServerName(serverName)) {
    throw new Error(`Invalid --ego-server-name value: ${serverName}`);
  }
  const dataRoot = process.env.AGENTSPACE_HOME || join(xdg("XDG_DATA_HOME", ".local/share"), "agentspace");
  const dataDir =
    serverName === DEFAULT_SERVER_NAME ? dataRoot : join(dataRoot, "servers", serverName);
  // An explicit AGENTSPACE_HOME is a separate installation with its own sockets.
  const runtimeRoot =
    process.env.XDG_RUNTIME_DIR && !process.env.AGENTSPACE_HOME
      ? join(process.env.XDG_RUNTIME_DIR, "agentspace")
      : join(dataRoot, "run");
  return {
    serverName,
    dataDir,
    profilesDir: join(dataDir, "profiles"),
    profilesFile: join(dataDir, "profiles.json"),
    spacesFile: join(dataDir, "spaces.json"),
    logFile: join(dataDir, "daemon.log"),
    socketPath: join(runtimeRoot, `${serverName}.sock`),
    panelFile: join(runtimeRoot, `${serverName}.panel.json`),
    runtimeDir: runtimeRoot,
  };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Bundled ego-browser SDK built from citrolabs/ego-lite package/ego-browser. */
export const BUNDLED_SDK = join(APP_ROOT, "sdk", "index.js");

/** Local SDK debug build that takes precedence over the bundled SDK. */
export function debugSdkPath() {
  return join(homedir(), ".ego-browser", "debug", "index.js");
}
