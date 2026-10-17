import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { APP_ROOT } from "./paths.mjs";

export const VERSION = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")).version;

const CHECK_INTERVAL_MS = 60 * 60 * 1000;
let lastCheck = 0;
let lastResult = false;

function git(args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", APP_ROOT, ...args], { timeout }, (error, stdout) => {
      resolve(error ? null : stdout.trim());
    });
  });
}

/**
 * agentspace's updater reports whether a newer release exists. A Linux install
 * is a git checkout, so an update is available when its upstream branch has
 * commits that HEAD does not.
 */
export async function updateStatus() {
  if (!existsSync(join(APP_ROOT, ".git"))) return false;
  if (Date.now() - lastCheck < CHECK_INTERVAL_MS) return lastResult;
  lastCheck = Date.now();
  if ((await git(["fetch", "--quiet"])) === null) return lastResult;
  const behind = await git(["rev-list", "--count", "HEAD..@{u}"]);
  lastResult = behind !== null && Number(behind) > 0;
  return lastResult;
}

export async function upgrade() {
  if (!existsSync(join(APP_ROOT, ".git"))) {
    throw new Error(`${APP_ROOT} is not a git checkout; reinstall agentspace to upgrade.`);
  }
  const before = await git(["rev-parse", "--short", "HEAD"]);
  const pulled = await git(["pull", "--ff-only", "--quiet"], 120_000);
  if (pulled === null) throw new Error("git pull --ff-only failed; resolve the checkout manually.");
  const after = await git(["rev-parse", "--short", "HEAD"]);
  return { before, after, updated: before !== after };
}
