#!/usr/bin/env node
// Benchmark: the same six-round "computer use" shopping task, driven
//   A) through agentspace (`agentspace run` + SDK, snapshot observations)
//   B) against plain Chromium over raw CDP (coordinate input, screenshot observations)
// Both use the same Chromium binary in headless mode, one process per round.
//
//   node bench/run.mjs [--iterations N] [--out file.json]

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXPECTED_SUMMARY, startApp } from "./app.mjs";
import { CdpConnection } from "../lib/cdp.mjs";
import { chromiumVersion, findChromium, launchChromium } from "../lib/chromium.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin", "agentspace");
const RAW_ROUND = join(ROOT, "bench", "raw-round.mjs");
const ROUNDS = 6;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const ITERATIONS = Number(option("--iterations", "5"));
const OUT = option("--out", undefined);

const ROUND_NAMES = [
  "open sign-in page",
  "sign in",
  "search products",
  "add item to cart",
  "cart -> checkout",
  "fill form, place order",
];

function agentspaceScript(round, baseUrl, taskName) {
  const head = `const task = await taskSpace(${JSON.stringify(taskName)});\nconst page = task.page("p1");\n`;
  const body = {
    1: `await page.goto(${JSON.stringify(`${baseUrl}/login`)});`,
    2: `await page.fill('loc=role:textbox[name="Username"]', "agent");
        await page.fill("input[name=pass]", "hunter2");
        await page.click('loc=role:button[name="Sign in"]');
        await page.waitForURL(/\\/shop/);`,
    3: `await page.fill('loc=role:textbox[name="Search"]', "keyboard");
        await page.press('loc=role:textbox[name="Search"]', "Enter");
        await page.waitForURL(/q=keyboard/);`,
    4: `await page.click('loc=role:button[name="Add Mechanical Keyboard K2 to cart"]');
        await page.waitForFunction(() => document.getElementById("cart-count").textContent === "1");`,
    5: `await page.click('loc=role:link[name="Cart (1)"]');
        await page.waitForURL(/\\/cart/);
        await page.click('loc=role:link[name="Checkout"]');
        await page.waitForURL(/\\/checkout/);`,
    6: `await page.fill('loc=role:textbox[name="Full name"]', "Ada Lovelace");
        await page.fill('loc=role:textbox[name="Address"]', "12 Analytical Engine Way");
        await page.click('loc=role:radio[name="Express"]');
        await page.click('loc=role:checkbox[name="I agree to the terms"]');
        await page.click('loc=role:button[name="Place order"]');
        await page.waitForURL(/\\/done/);`,
  }[round];
  // Observation last, as the agent guide prescribes.
  return `${head}${body}\nconsole.log(await page.snapshot());\n`;
}

function run(command, commandArgs, { input, env } = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(command, commandArgs, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (code !== 0) reject(new Error(`${command} ${commandArgs.join(" ")} exited ${code}\n${stderr}`));
      else resolve({ ms, stdout });
    });
    child.stdin.end(input ?? "");
  });
}

// Resident memory of every process whose command line mentions `marker`.
function rssMiB(marker) {
  const out = execFileSync("ps", ["-eo", "rss=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let kib = 0;
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].includes(marker)) kib += Number(match[1]);
  }
  return Math.round(kib / 1024);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

async function benchAgentspace(baseUrl) {
  const home = mkdtempSync(join(tmpdir(), "agentspace-bench-"));
  const env = { AGENTSPACE_HOME: home, AGENTSPACE_HEADLESS: "1" };
  const daemon = spawn(process.execPath, [join(ROOT, "lib", "cli.mjs"), "daemon"], {
    env: { ...process.env, ...env },
    stdio: "ignore",
  });
  try {
    const cold = await run(CLI, ["start"], { env });
    // Fixed per-round cost: CLI -> daemon -> Node helper with the SDK loaded.
    const noop = [];
    for (let index = 0; index < 5; index += 1) noop.push((await run(CLI, ["run"], { input: "1;", env })).ms);
    let sampleSnapshot;
    let memory;
    const iterations = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const taskName = `bench-${iteration}`;
      const rounds = [];
      for (let round = 1; round <= ROUNDS; round += 1) {
        const { ms, stdout } = await run(CLI, ["run"], { input: agentspaceScript(round, baseUrl, taskName), env });
        rounds.push({ ms, observationChars: stdout.length });
        if (iteration === 0 && round === 4) sampleSnapshot = stdout;
        if (round === ROUNDS && !stdout.includes(EXPECTED_SUMMARY)) {
          throw new Error(`agentspace run ${iteration} did not reach the order summary:\n${stdout}`);
        }
      }
      iterations.push(rounds);
      // Memory with the finished task still open, before cleanup.
      if (iteration === ITERATIONS - 1) memory = rssMiB(home) + rssMiB(`${join(ROOT, "lib", "cli.mjs")} daemon`);
      await run(CLI, ["run"], {
        input: `const task = await taskSpace(${JSON.stringify(taskName)}); await task.finish({ keep: [] });`,
        env,
      });
    }
    return { coldStartMs: cold.ms, noopRoundMs: median(noop), iterations, memoryMiB: memory, sampleSnapshot };
  } finally {
    await run(CLI, ["stop"], { env }).catch(() => {});
    daemon.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(home, { recursive: true, force: true });
  }
}

async function benchRawChromium(baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), "raw-chromium-bench-"));
  const started = process.hrtime.bigint();
  const browser = await launchChromium({ userDataDir: dir, logFile: join(dir, "chromium.log"), headless: true });
  const coldStartMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Fixed per-round cost: Node start + DevTools WebSocket connect.
  const noop = [];
  for (let index = 0; index < 5; index += 1) {
    noop.push(
      (
        await run(process.execPath, [
          "--input-type=module",
          "-e",
          `import { CdpConnection } from ${JSON.stringify(join(ROOT, "lib", "cdp.mjs"))};
           const conn = await CdpConnection.connect(${JSON.stringify(browser.wsUrl)});
           await conn.send("Browser.getVersion");
           conn.close();`,
        ])
      ).ms,
    );
  }
  try {
    const iterations = [];
    let memory;
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const stateFile = join(dir, `state-${iteration}.json`);
      const rounds = [];
      for (let round = 1; round <= ROUNDS; round += 1) {
        const { ms, stdout } = await run(process.execPath, [RAW_ROUND, browser.wsUrl, stateFile, String(round), baseUrl]);
        const observation = JSON.parse(stdout.trim());
        rounds.push({ ms, ...observation });
        if (round === ROUNDS && observation.summary !== EXPECTED_SUMMARY) {
          throw new Error(`raw run ${iteration} ended with ${JSON.stringify(observation.summary)}`);
        }
      }
      iterations.push(rounds);
      if (iteration === ITERATIONS - 1) memory = rssMiB(dir);
      const { targetId } = JSON.parse(readFileSync(stateFile, "utf8"));
      const conn = await CdpConnection.connect(browser.wsUrl);
      await conn.send("Target.closeTarget", { targetId });
      conn.close();
    }
    return { coldStartMs, noopRoundMs: median(noop), iterations, memoryMiB: memory };
  } finally {
    try {
      process.kill(-browser.child.pid, "SIGTERM");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(dir, { recursive: true, force: true });
  }
}

function summarize(result, observe) {
  const perRound = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const samples = result.iterations.map((rounds) => rounds[round]);
    perRound.push({
      name: ROUND_NAMES[round],
      medianMs: Math.round(median(samples.map((sample) => sample.ms))),
      ...observe(samples),
    });
  }
  const totals = result.iterations.map((rounds) => rounds.reduce((sum, round) => sum + round.ms, 0));
  return {
    coldStartMs: Math.round(result.coldStartMs),
    noopRoundMs: Math.round(result.noopRoundMs),
    medianTaskMs: Math.round(median(totals)),
    minTaskMs: Math.round(Math.min(...totals)),
    maxTaskMs: Math.round(Math.max(...totals)),
    memoryMiB: result.memoryMiB,
    perRound,
  };
}

// Text: ~4 characters per token. Images: width*height/750 tokens
// (Anthropic's published estimate for image inputs).
const textTokens = (chars) => Math.round(chars / 4);
const imageTokens = (width, height) => Math.round((width * height) / 750);

const { server, baseUrl } = await startApp();
try {
  const agentspace = await benchAgentspace(baseUrl);
  const raw = await benchRawChromium(baseUrl);
  const report = {
    date: new Date().toISOString(),
    chromium: chromiumVersion(findChromium()),
    node: process.version,
    cpu: execFileSync("sh", ["-c", "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"], { encoding: "utf8" }).trim(),
    iterations: ITERATIONS,
    agentspace: summarize(agentspace, (samples) => {
      const chars = median(samples.map((sample) => sample.observationChars));
      return { observationChars: chars, observationTokens: textTokens(chars) };
    }),
    rawChromium: summarize(raw, (samples) => {
      const sample = samples[0];
      return {
        screenshotBytes: Math.round(median(samples.map((item) => item.screenshotBytes))),
        screenshotSize: `${sample.width}x${sample.height}`,
        screenshotTokens: imageTokens(sample.width, sample.height),
        htmlChars: median(samples.map((item) => item.htmlChars)),
        htmlTokens: textTokens(median(samples.map((item) => item.htmlChars))),
      };
    }),
  };
  report.agentspace.sampleSnapshot = agentspace.sampleSnapshot;
  const text = JSON.stringify(report, null, 2);
  if (OUT) writeFileSync(OUT, `${text}\n`);
  console.log(text);
} finally {
  server.close();
}
