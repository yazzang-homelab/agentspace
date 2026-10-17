import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseImportArgs } from "../lib/importer.mjs";
import { servicePaths, validServerName } from "../lib/paths.mjs";
import { normalizeSnapshotOptions, roleName } from "../lib/snapshot.mjs";
import { compileScript } from "../lib/node-host.mjs";
import { ProfileStore } from "../lib/profiles.mjs";
import { createEgoBindings } from "../lib/ego-client.mjs";

test("server names follow the native --ego-server-name rules", () => {
  assert.equal(validServerName("app-a.1_b"), true);
  assert.equal(validServerName(""), false);
  assert.equal(validServerName("a b"), false);
  assert.equal(validServerName("../x"), false);
  assert.throws(() => servicePaths("a/b"), /Invalid --ego-server-name value/);
});

test("named services get separate data and sockets", () => {
  const previous = process.env.AGENTSPACE_HOME;
  process.env.AGENTSPACE_HOME = "/tmp/ego-unit-home";
  try {
    const main = servicePaths("default");
    const other = servicePaths("app-a");
    assert.equal(main.dataDir, "/tmp/ego-unit-home");
    assert.equal(other.dataDir, "/tmp/ego-unit-home/servers/app-a");
    assert.notEqual(main.socketPath, other.socketPath);
  } finally {
    if (previous === undefined) delete process.env.AGENTSPACE_HOME;
    else process.env.AGENTSPACE_HOME = previous;
  }
});

test("import arguments group profiles under the latest --browser block", () => {
  const parsed = parseImportArgs([
    "--browser",
    "chrome",
    "--profile",
    "Default",
    "Profile 1",
    "--browser",
    "brave",
    "--clear-existing-profiles",
    "--no-default",
  ]);
  assert.deepEqual(parsed.blocks, [
    { browser: "chrome", profiles: ["Default", "Profile 1"] },
    { browser: "brave", profiles: [] },
  ]);
  assert.equal(parsed.clearExistingProfiles, true);
  assert.equal(parsed.setDefault, false);
  assert.throws(() => parseImportArgs(["--browser", "safari"]), /Unsupported browser: safari/);
  assert.throws(() => parseImportArgs(["--profile", "Default"]), /must follow a --browser block/);
  assert.throws(() => parseImportArgs([]), /--browser/);
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
