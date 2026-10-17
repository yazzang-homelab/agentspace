import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_INSTANCE = "default";
const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export function validInstanceName(name) {
  return typeof name === "string" && INSTANCE_NAME_PATTERN.test(name);
}

function xdg(variable, fallback) {
  const value = process.env[variable];
  return value && value.startsWith("/") ? value : join(homedir(), fallback);
}

/** Every path one named browser service owns. */
export function servicePaths(instance = DEFAULT_INSTANCE) {
  if (!validInstanceName(instance)) {
    throw new Error(`Invalid --instance value: ${instance}`);
  }
  const dataRoot = process.env.AGENTSPACE_HOME || join(xdg("XDG_DATA_HOME", ".local/share"), "agentspace");
  const dataDir =
    instance === DEFAULT_INSTANCE ? dataRoot : join(dataRoot, "instances", instance);
  // An explicit AGENTSPACE_HOME is a separate installation with its own sockets.
  const runtimeRoot =
    process.env.XDG_RUNTIME_DIR && !process.env.AGENTSPACE_HOME
      ? join(process.env.XDG_RUNTIME_DIR, "agentspace")
      : join(dataRoot, "run");
  return {
    instance,
    dataDir,
    profilesDir: join(dataDir, "profiles"),
    profilesFile: join(dataDir, "profiles.json"),
    spacesFile: join(dataDir, "spaces.json"),
    logFile: join(dataDir, "daemon.log"),
    socketPath: join(runtimeRoot, `${instance}.sock`),
    panelFile: join(runtimeRoot, `${instance}.panel.json`),
    runtimeDir: runtimeRoot,
  };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/** Bundled SDK built from citrolabs/ego-lite package/ego-browser (MIT). */
export const BUNDLED_SDK = join(APP_ROOT, "sdk", "index.js");

