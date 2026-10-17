// `ego-browser import`: copy Chromium-family browser profiles on this machine
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

export function parseImportArgs(args) {
  const blocks = [];
  let clearExistingProfiles = false;
  let setDefault = true;
  let current = null;
  let collectingProfiles = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--browser") {
      const id = args[++index];
      if (!id || !BROWSERS[id]) {
        throw new Error(`Unsupported browser: ${id ?? "(missing)"}. Supported: ${Object.keys(BROWSERS).join(", ")}`);
      }
      current = { browser: id, profiles: [] };
      blocks.push(current);
      collectingProfiles = false;
    } else if (arg === "--profile") {
      if (!current) throw new Error("--profile must follow a --browser block");
      collectingProfiles = true;
    } else if (arg === "--clear-existing-profiles") {
      clearExistingProfiles = true;
      collectingProfiles = false;
    } else if (arg === "--no-default") {
      setDefault = false;
      collectingProfiles = false;
    } else if (collectingProfiles && !arg.startsWith("--")) {
      current.profiles.push(arg);
    } else {
      throw new Error(`Unknown import option: ${arg}`);
    }
  }
  if (blocks.length === 0) throw new Error("Pass --browser <browser> or use `ego-browser import list`.");
  return { blocks, clearExistingProfiles, setDefault };
}

/** Copy the selected source profiles. The daemon must not use target dirs. */
export function importProfiles(paths, { blocks, clearExistingProfiles }) {
  const detected = new Map(detectBrowsers().map((browser) => [browser.id, browser]));
  const store = new ProfileStore(paths.profilesFile);
  const plan = [];
  for (const block of blocks) {
    const browser = detected.get(block.browser);
    if (!browser) throw new Error(`${BROWSERS[block.browser].label} was not found under ${browserRoot(block.browser)}`);
    const selected = block.profiles.length
      ? block.profiles.map((dir) => {
          const profile = browser.profiles.find((item) => item.dir === dir);
          if (!profile) throw new Error(`${browser.label} has no profile directory named ${JSON.stringify(dir)}`);
          return profile;
        })
      : browser.profiles;
    for (const profile of selected) plan.push({ browser, profile });
  }
  if (plan.length === 0) throw new Error("No source profiles to import.");

  const existing = clearExistingProfiles ? [] : store.list().map(({ id, name }) => ({ id, name }));
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
    if (clearExistingProfiles) rmSync(paths.profilesDir, { recursive: true, force: true });
    ensureDir(paths.profilesDir);
    for (const profile of imported) {
      const destination = join(paths.profilesDir, profile.id);
      rmSync(destination, { recursive: true, force: true });
      cpSync(join(staging, profile.id), destination, { recursive: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const profiles = [...existing, ...imported.map(({ id, name }) => ({ id, name }))];
  const defaultId = clearExistingProfiles ? imported[0].id : store.defaultId;
  store.replaceAll(profiles, defaultId);
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
