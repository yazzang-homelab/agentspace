import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseImportArgs } from "../lib/importer.mjs";
import { servicePaths, validInstanceName } from "../lib/paths.mjs";
import { normalizeSnapshotOptions, roleName } from "../lib/snapshot.mjs";
import { compileScript } from "../lib/node-host.mjs";
import { ProfileStore } from "../lib/profiles.mjs";
import { createEgoBindings } from "../lib/ego-client.mjs";

test("instance names are 1-64 safe characters", () => {
  assert.equal(validInstanceName("app-a.1_b"), true);
  assert.equal(validInstanceName(""), false);
  assert.equal(validInstanceName("a b"), false);
  assert.equal(validInstanceName("../x"), false);
  assert.throws(() => servicePaths("a/b"), /Invalid --instance value/);
});

test("named services get separate data and sockets", () => {
  const previous = process.env.AGENTSPACE_HOME;
  process.env.AGENTSPACE_HOME = "/tmp/ego-unit-home";
  try {
    const main = servicePaths("default");
    const other = servicePaths("app-a");
    assert.equal(main.dataDir, "/tmp/ego-unit-home");
    assert.equal(other.dataDir, "/tmp/ego-unit-home/instances/app-a");
    assert.notEqual(main.socketPath, other.socketPath);
  } finally {
    if (previous === undefined) delete process.env.AGENTSPACE_HOME;
    else process.env.AGENTSPACE_HOME = previous;
  }
});

test("profiles import takes one browser, optional profile dirs and flags", () => {
  assert.deepEqual(parseImportArgs(["chrome", "Default", "Profile 1", "--replace"]), {
    browser: "chrome",
    profiles: ["Default", "Profile 1"],
    replace: true,
    setDefaultBrowser: false,
  });
  assert.deepEqual(parseImportArgs(["--set-default-browser", "brave"]), {
    browser: "brave",
    profiles: [],
    replace: false,
    setDefaultBrowser: true,
  });
  assert.throws(() => parseImportArgs(["safari"]), /Unsupported browser: safari/);
  assert.throws(() => parseImportArgs(["chrome", "--no-default"]), /Unknown import option: --no-default/);
  assert.throws(() => parseImportArgs([]), /profiles detect/);
});

test("snapshot role names use the native snake_case vocabulary", () => {
  assert.equal(roleName("RootWebArea"), "root");
  assert.equal(roleName("StaticText"), "text");
  assert.equal(roleName("LabelText"), "label_text");
  assert.equal(roleName("SvgRoot"), "svg_root");
  assert.equal(roleName("generic"), "container");
  assert.equal(roleName("button"), "button");
});

test("snapshot options are validated like ego.snapshot()", () => {
  assert.deepEqual(normalizeSnapshotOptions(undefined), {
    scope: "full_page",
    root: undefined,
    includeActionMarks: true,
    interactiveOnly: false,
    includeStableLocator: false,
    maxResultLength: 0,
  });
  assert.throws(() => normalizeSnapshotOptions({ scope: "nope" }), /only_within_viewport/);
  assert.throws(() => normalizeSnapshotOptions({ scope: "subtree" }), /requires root/);
  assert.throws(() => normalizeSnapshotOptions([]), /options object/);
  assert.equal(normalizeSnapshotOptions({ scope: "subtree", root: 7 }).root, 7);
});

test("scripts support top-level await and report syntax errors by source line", async () => {
  assert.equal(await compileScript("return await Promise.resolve(41) + 1;")(), 42);
  assert.throws(
    () => compileScript("const a = 1;\nconst b = 2;\nconst c = 3;\nlet x = );"),
    (error) =>
      error instanceof SyntaxError &&
      /line 4, column 9/.test(error.message) &&
      error.message.includes("4 | let x = );"),
  );
});

test("profile store keeps a default profile and persists replacements", () => {
  const dir = mkdtempSync(join(tmpdir(), "ego-profiles-"));
  const file = join(dir, "profiles.json");
  const store = new ProfileStore(file);
  assert.deepEqual(store.list(), [{ id: "Default", name: "Personal", isDefault: true }]);
  assert.equal(store.resolve(undefined).id, "Default");
  assert.equal(store.resolve("missing"), undefined);
  store.replaceAll([{ id: "Profile 1", name: "Work" }], "Profile 1");
  assert.ok(existsSync(file));
  assert.deepEqual(new ProfileStore(file).list(), [{ id: "Profile 1", name: "Work", isDefault: true }]);
  mkdirSync(join(dir, "unused"));
  writeFileSync(join(dir, "broken.json"), "{");
  assert.equal(new ProfileStore(join(dir, "broken.json")).defaultId, "Default");
  assert.ok(readFileSync(file, "utf8").includes("Work"));
});

test("bindings validate arguments synchronously and scope calls to the selected space", async () => {
  const calls = [];
  const client = {
    connected: true,
    setCdpHandlers() {},
    call(method, spaceId, args) {
      calls.push([method, spaceId, args]);
      return Promise.resolve({ value: "ok" });
    },
    sendCdp(spaceId, message) {
      calls.push(["cdp", spaceId, message]);
    },
  };
  const ego = createEgoBindings(client);
  assert.throws(() => ego.useTaskSpace("1"), (error) => error.error_code === "EGO_INVALID_ARGUMENT");
  assert.throws(() => ego.createTab(), /url/);
  assert.throws(() => ego.closeTaskSpace(1), /does not accept arguments/);
  assert.throws(() => ego.snapshot("x"), /options object/);

  const errors = [];
  ego.onSendCDPMessageError = (message, code) => errors.push([message, code]);
  ego.sendCDPMessage(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [["Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED"]]);

  assert.equal(ego.useTaskSpace(5), 5);
  assert.equal(await ego.listTabs(), "ok");
  ego.sendCDPMessage('{"id":2,"method":"Browser.getVersion"}');
  assert.deepEqual(calls, [
    ["listTabs", 5, []],
    ["cdp", 5, '{"id":2,"method":"Browser.getVersion"}'],
  ]);
  assert.equal(Object.keys(ego).includes("onCDPMessage"), false);
  ego.onCDPMessage = "not a function";
  assert.equal(ego.onCDPMessage, undefined);
});
