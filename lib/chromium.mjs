import { spawn, execFileSync } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "brave-browser",
  "microsoft-edge-stable",
];

export function findChromium() {
  const configured = process.env.AGENTSPACE_CHROMIUM;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`AGENTSPACE_CHROMIUM does not exist: ${configured}`);
    }
    return configured;
  }
  for (const name of CANDIDATES) {
    try {
      const found = execFileSync("sh", ["-c", `command -v ${name}`], {
        encoding: "utf8",
      }).trim();
      if (found) return found;
    } catch {}
  }
  throw new Error(
    "No Chromium-based browser found. Install chromium (apt install chromium) or set AGENTSPACE_CHROMIUM.",
  );
}

export function chromiumVersion(binary) {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Headful when a display is available, unless AGENTSPACE_HEADLESS overrides it. */
export function wantHeadless() {
  const flag = process.env.AGENTSPACE_HEADLESS;
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/**
 * Launch one Chromium process for one agentspace profile directory and resolve its
 * browser-level DevTools WebSocket URL from DevToolsActivePort.
 */
export async function launchChromium({ userDataDir, logFile, headless = wantHeadless() }) {
  const binary = findChromium();
  const portFile = join(userDataDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=http://127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--disable-features=Translate,MediaRouter,DialMediaRouteProvider",
    "--enable-features=SnapshotSubtree",
  ];
  if (headless) args.push("--headless=new", "--window-size=1280,900");
  if (process.getuid?.() === 0) args.push("--no-sandbox");
  if (process.env.AGENTSPACE_CHROMIUM_FLAGS) {
    args.push(...process.env.AGENTSPACE_CHROMIUM_FLAGS.split(/\s+/).filter(Boolean));
  }
  args.push("about:blank");
  const out = openSync(logFile, "a");
  const child = spawn(binary, args, {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited during startup (code ${child.exitCode}); see ${logFile}`);
    }
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
      if (port && path) {
        return { child, binary, headless, wsUrl: `ws://127.0.0.1:${port}${path}`, port: Number(port) };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  throw new Error(`Chromium did not publish DevToolsActivePort within 30s; see ${logFile}`);
}
