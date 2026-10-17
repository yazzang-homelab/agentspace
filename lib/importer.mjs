// `agentspace profiles import`: copy Chromium-family browser profiles on this machine
// into new agentspace profiles (each a separate Chromium user-data-dir).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { ensureDir } from "./paths.mjs";
import { ProfileStore } from "./profiles.mjs";

export const BROWSERS = {
  chrome: { label: "Google Chrome", dir: ".config/google-chrome" },
  chromium: { label: "Chromium", dir: ".config/chromium" },
  edge: { label: "Microsoft Edge", dir: ".config/microsoft-edge" },
  brave: { label: "Brave", dir: ".config/BraveSoftware/Brave-Browser" },
};

// Caches and per-process state that must not be copied into a new profile.
const SKIPPED = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "Service Worker",
  "Crashpad",
  "blob_storage",
  "Download Service",
]);

function browserRoot(id) {
  return join(homedir(), BROWSERS[id].dir);
}

/** Detected browsers and their profile directories. */
export function detectBrowsers() {
  const found = [];
  for (const [id, browser] of Object.entries(BROWSERS)) {
    const root = browserRoot(id);
    const localState = join(root, "Local State");
    if (!existsSync(localState)) continue;
    let cache = {};
    try {
      cache = JSON.parse(readFileSync(localState, "utf8")).profile?.info_cache || {};
    } catch {}
    const profiles = Object.entries(cache)
      .filter(([dir]) => existsSync(join(root, dir)))
      .map(([dir, info]) => ({ dir, name: info?.name || dir }));
    found.push({ id, label: browser.label, root, profiles });
  }
  return found;
}

/** `profiles import <browser> [<profile-dir>...] [--replace] [--set-default-browser]` */
export function parseImportArgs(args) {
  let browser;
  const profiles = [];
  let replace = false;
  let setDefaultBrowser = false;
  for (const arg of args) {
    if (arg === "--replace") replace = true;
    else if (arg === "--set-default-browser") setDefaultBrowser = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown import option: ${arg}`);
    else if (browser === undefined) browser = arg;
    else profiles.push(arg);
  }
  if (browser === undefined) throw new Error("Name the browser to import from, or run `agentspace profiles detect`.");
  if (!BROWSERS[browser]) {
    throw new Error(`Unsupported browser: ${browser}. Supported: ${Object.keys(BROWSERS).join(", ")}`);
  }
  return { browser, profiles, replace, setDefaultBrowser };
}

/** Copy the selected source profiles. The daemon must not use target dirs. */
export function importProfiles(paths, { browser: browserId, profiles, replace }) {
  const detected = new Map(detectBrowsers().map((browser) => [browser.id, browser]));
  const store = new ProfileStore(paths.profilesFile);
  const browser = detected.get(browserId);
  if (!browser) throw new Error(`${BROWSERS[browserId].label} was not found under ${browserRoot(browserId)}`);
  const selected = profiles.length
    ? profiles.map((dir) => {
        const profile = browser.profiles.find((item) => item.dir === dir);
        if (!profile) throw new Error(`${browser.label} has no profile directory named ${JSON.stringify(dir)}`);
        return profile;
      })
    : browser.profiles;
  const plan = selected.map((profile) => ({ browser, profile }));
  if (plan.length === 0) throw new Error("No source profiles to import.");

  const existing = replace ? [] : store.list().map(({ id, name }) => ({ id, name }));
  const taken = new Set(existing.map((profile) => profile.id));
  const imported = [];
  const staging = ensureDir(join(paths.dataDir, "import-staging"));
  try {
    for (const { browser, profile } of plan) {
      let index = 1;
      let id = existing.length === 0 && imported.length === 0 ? "Default" : `Profile ${index}`;
      while (taken.has(id)) id = `Profile ${++index}`;
      taken.add(id);
      const target = join(staging, id, "Default");
      cpSync(join(browser.root, profile.dir), target, {
        recursive: true,
        filter: (source) => !SKIPPED.has(basename(source)) && !basename(source).startsWith("Singleton"),
      });
      imported.push({ id, name: `${profile.name} (${browser.label})`, source: `${browser.id}/${profile.dir}` });
    }
    if (replace) rmSync(paths.profilesDir, { recursive: true, force: true });
    ensureDir(paths.profilesDir);
    for (const profile of imported) {
      const destination = join(paths.profilesDir, profile.id);
      rmSync(destination, { recursive: true, force: true });
      cpSync(join(staging, profile.id), destination, { recursive: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const nextProfiles = [...existing, ...imported.map(({ id, name }) => ({ id, name }))];
  const defaultId = replace ? imported[0].id : store.defaultId;
  store.replaceAll(nextProfiles, defaultId);
  return imported;
}

/** Register agentspace as the desktop default browser via xdg-settings. */
export function setDefaultBrowser() {
  const desktop = join(homedir(), ".local/share/applications/agentspace.desktop");
  if (!existsSync(desktop)) return "skipped: agentspace.desktop is not installed (run install.sh)";
  try {
    execFileSync("xdg-settings", ["set", "default-web-browser", "agentspace.desktop"], { stdio: "ignore" });
    return "agentspace is now the default browser";
  } catch {
    return "skipped: xdg-settings could not set the default browser";
  }
}
