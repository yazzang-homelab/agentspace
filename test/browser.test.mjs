// End-to-end tests against a real headless Chromium, through the public CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findChromium } from "../lib/chromium.mjs";

const CLI = fileURLToPath(new URL("../bin/ego-browser", import.meta.url));
const DAEMON = fileURLToPath(new URL("../lib/cli.mjs", import.meta.url));

let chromiumAvailable = true;
try {
  findChromium();
} catch {
  chromiumAvailable = false;
}

const PAGES = {
  "/": `<!doctype html><title>Fixture</title>
    <h1>Hello fixture</h1>
    <p>Plain <b>bold</b> text.</p>
    <label>Email <input id="email" placeholder="you@example.com"></label>
    <button onclick="document.querySelector('#out').textContent = 'clicked'">Save</button>
    <button>Repeat</button><button>Repeat</button>
    <a href="/dup">One</a><a href="/dup">Two</a><a href="/unique">Unique</a>
    <div id="out"></div>
    <iframe src="/frame" width="300" height="80"></iframe>
    <div style="height: 3000px"></div>
    <button id="far">Far away</button>`,
  "/frame": `<!doctype html><button>Frame button</button>`,
  "/popup": `<!doctype html><title>Opener</title><a href="/frame" target="_blank">Open</a>`,
};

let home;
let server;
let baseUrl;
let daemon;

// Async spawn: the fixture server lives in this process and must keep serving.
function run(args, input) {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { env: { ...process.env, AGENTSPACE_HOME: home } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

function cli(script) {
  return run(["nodejs"], script);
}

async function json(script) {
  const result = await cli(script);
  assert.equal(result.code, 0, result.stderr);
  // The SDK may print guidance after the script output; take the JSON line.
  const line = result.stdout
    .trim()
    .split("\n")
    .findLast((item) => /^[[{"]/.test(item));
  assert.ok(line, `no JSON output:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(line);
}

test.before(async () => {
  if (!chromiumAvailable) return;
  home = mkdtempSync(join(tmpdir(), "agentspace-test-"));
  server = createServer((request, response) => {
    const page = PAGES[new URL(request.url, "http://x").pathname];
    response.writeHead(page ? 200 : 404, { "content-type": "text/html" }).end(page || "missing");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  daemon = spawn(process.execPath, [DAEMON, "daemon"], {
    env: { ...process.env, AGENTSPACE_HOME: home, AGENTSPACE_HEADLESS: "1" },
    stdio: "ignore",
  });
});

test.after(async () => {
  if (!chromiumAvailable) return;
  await run(["stop"]);
  daemon?.kill();
  server?.close();
  // Chromium may still be flushing its profile for a moment after it exits.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(home, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
});

test("a task space drives a page and prints the native snapshot format", { skip: !chromiumAvailable }, async () => {
  const result = await cli(`
    const task = await taskSpace("browser-test");
    const page = task.page("p1");
    await page.goto(${JSON.stringify(baseUrl + "/")});
    await page.fill("#email", "a@b.c");
    await page.click("text=Save");
    console.log(await page.evaluate(() => document.querySelector("#out").textContent));
    console.log("---");
    console.log(await page.snapshot({ scope: "full_page" }));
  `);
  assert.equal(result.code, 0, result.stderr);
  const [clicked, snapshot] = result.stdout.split("---\n");
  assert.match(clicked, /clicked/);
  const lines = snapshot.split("\n");
  assert.ok(lines.includes("root"), snapshot);
  assert.ok(lines.includes('  heading "Hello fixture" level=1'), snapshot);
  assert.match(snapshot, /textbox "Email" value="a@b\.c" \[ref=\d+, loc=css:#email\]/);
  assert.match(snapshot, /button "Save" (focused )?\[ref=\d+, loc=role:button\[name="Save"\]\]/);
  // Duplicate names and duplicate hrefs get no stable locator.
  assert.match(snapshot, /button "Repeat" \[ref=\d+\]\n/);
  assert.match(snapshot, /link "One" \[ref=\d+, url=http:\/\/127\.0\.0\.1:\d+\/dup\]/);
  assert.match(snapshot, /link "Unique" \[ref=\d+, loc=href:\/unique, url=/);
  // Each text node stays on its own line.
  assert.ok(lines.some((line) => line.trim() === 'text "bold"'), snapshot);
  // Iframe content nests under its own root.
  assert.match(snapshot, /iframe \[ref=\d+\]\n\s+root\n\s+button "Frame button"/);
});

test("viewport snapshots omit offscreen content", { skip: !chromiumAvailable }, async () => {
  const result = await cli(`
    const task = await taskSpace("browser-test");
    console.log(await task.page("p1").snapshot());
  `);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Hello fixture/);
  assert.doesNotMatch(result.stdout, /Far away/);
});

test("raw CDP only sees the task space's own targets", { skip: !chromiumAvailable }, async () => {
  const visible = await json(`
    const other = await taskSpace("browser-test-other");
    await other.page("p1").goto(${JSON.stringify(baseUrl + "/frame")});
    const task = await taskSpace("browser-test");
    const { targetInfos } = await task.cdp("Target.getTargets");
    console.log(JSON.stringify(targetInfos.filter((t) => t.type === "page").map((t) => t.url)));
  `);
  assert.ok(visible.some((url) => url.startsWith(baseUrl + "/")), JSON.stringify(visible));
  assert.ok(!visible.includes(baseUrl + "/frame"), JSON.stringify(visible));
  const blocked = await cli(`
    const task = await taskSpace("browser-test");
    try {
      await task.cdp("Browser.close");
      console.log("closed");
    } catch (error) {
      console.log("blocked:", error.message);
    }
  `);
  assert.match(blocked.stdout, /blocked: .*not available inside this task space/);
});

test("popups opened by an agent tab join its task space", { skip: !chromiumAvailable }, async () => {
  const result = await json(`
    const task = await taskSpace("browser-test");
    const page = task.page("p1");
    await page.goto(${JSON.stringify(baseUrl + "/popup")});
    const popup = page.waitForEvent("popup");
    await page.click("text=Open");
    const child = await popup;
    const tabs = (await ego.listTabs()).tabs.map((tab) => tab.url);
    console.log(JSON.stringify({ label: child.label, tabs }));
  `);
  assert.ok(result.label, JSON.stringify(result));
  assert.ok(result.tabs.includes(baseUrl + "/frame"), JSON.stringify(result));
});

test("handing a space to the user stops automation until it is taken back", { skip: !chromiumAvailable }, async () => {
  const handed = await json(`
    // Raw bindings only: SDK background CDP would turn the handoff into a hard stop.
    const { taskSpaces } = await ego.listTaskSpaces();
    ego.useTaskSpace(taskSpaces.find((space) => space.name === "browser-test").id);
    await ego.handOffTaskSpace();
    const snapshot = await ego.snapshot().then(() => null, (error) => error.error_code);
    const tabs = await ego.listTabs();
    await ego.takeOverTaskSpace();
    const after = await ego.listTabs();
    console.log(JSON.stringify({ snapshot, tabs: tabs.error_code, after: Array.isArray(after.tabs) }));
  `);
  assert.deepEqual(handed, {
    snapshot: "EGO_TASK_SPACE_USER_IN_CONTROL",
    tabs: "EGO_TASK_SPACE_USER_IN_CONTROL",
    after: true,
  });
});

test("paste goes through the browser clipboard and restores it", { skip: !chromiumAvailable }, async () => {
  const result = await json(`
    const task = await taskSpace("browser-test");
    const page = task.page("p1");
    await page.goto(${JSON.stringify(baseUrl + "/")});
    await page.click("#email");
    await page.keyboard.paste("pasted text");
    console.log(JSON.stringify(await page.evaluate(() => document.querySelector("#email").value)));
  `);
  assert.equal(result, "pasted text");
});

test("completing a space hands it to the user and closing removes it", { skip: !chromiumAvailable }, async () => {
  const result = await json(`
    const done = await taskSpace("browser-test-other");
    await done.finish({ keep: ["p1"] });
    const task = await taskSpace("browser-test");
    ego.useTaskSpace(task.spaceId);
    await ego.closeTaskSpace();
    const spaces = (await ego.listTaskSpaces()).taskSpaces;
    console.log(JSON.stringify(spaces.map((space) => [space.name, space.ownership])));
  `);
  assert.ok(result.some(([name, ownership]) => name === "browser-test-other" && ownership === "user"), JSON.stringify(result));
  assert.ok(!result.some(([name]) => name === "browser-test"), JSON.stringify(result));
});

test("CLI errors use the native messages and exit codes", { skip: !chromiumAvailable }, async () => {
  const unknown = await run(["bogus"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /^Unknown command: bogus/);
  const invalid = await run(["--ego-server-name=a b", "help"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /Invalid --ego-server-name value/);
  const failing = await cli("throw new Error('boom');");
  assert.equal(failing.code, 1);
  assert.match(failing.stderr, /Error: boom/);
  const skill = await run(["skill"]);
  assert.equal(skill.code, 0);
  assert.match(skill.stdout, /\[ego-browser:skill\] end of guide/);
});
