#!/usr/bin/env node
// agentspace command-line interface.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { connectDaemon, DaemonClient } from "./ego-client.mjs";
import { LineSocket } from "./wire.mjs";
import { BUNDLED_SDK, DEFAULT_INSTANCE, servicePaths, validInstanceName } from "./paths.mjs";
import { ProfileStore } from "./profiles.mjs";
import { VERSION, upgrade } from "./version.mjs";

const MAIN_HELP = `agentspace ${VERSION} - a browser shared by you and your AI agents

Usage: agentspace [-i <instance>] <command> [options]

Agent commands:
  run [file] [-e <code>]    Run an agent script (stdin when piped, REPL on a TTY)
  guide                     Print the agent usage guide

Browser:
  start                     Start the daemon and the default profile's browser
  stop                      Stop the daemon and every browser
  status                    Show browsers and Spaces
  open <url>                Open a URL for yourself (a user Space)
  panel                     Open the Spaces control panel

Profiles:
  profiles                  List profiles
  profiles detect           List Chrome/Chromium/Edge/Brave profiles to import
  profiles import <browser> Copy profiles from another browser

Maintenance:
  upgrade                   Update this installation (git pull)
  help [command]            Show help for a command

Options:
  -i, --instance <name>     Use a separate, named agentspace instance
  -v, --version             Print the version

Agents: read ~/.agents/skills/agentspace/SKILL.md, then run \`agentspace guide\`.
`;

const TOPICS = {
  run: `agentspace run - Run an agent script

Usage:
  agentspace run <file>
  agentspace run -e <code>
  agentspace run < script.js
  agentspace run                 (interactive REPL when stdin is a terminal)

The script runs in agentspace's Node helper with \`globalThis.ego\` and the
ego-browser SDK (\`taskSpace\`, \`listTaskSpaces\`, ...) installed. Top-level
await works. The helper does not inherit your shell's environment or working
directory, so pass every input inside the script.

Options:
  -e, --eval <code>     Run this code
  --sdk-path <path>     Load this SDK build instead of the bundled one

REPL: \`.cell\` starts a multi-line block, \`.end\` runs it, \`.cancel\` drops it,
\`.exit\` or Ctrl-D quits. One input can be up to 64 MiB.

Example:
  agentspace run <<'EOF'
  const task = await taskSpace("example");
  await task.page("p1").goto("https://example.com");
  console.log(await task.page("p1").snapshot());
  EOF
`,
  guide: `agentspace guide - Print the agent usage guide

Usage:
  agentspace guide [--sdk-path <path>]

Prints the usage guide for the bundled SDK (or the guide next to --sdk-path).
Agents should read it before any browser task and again after an upgrade.
`,
  start: `agentspace start - Start agentspace

Usage:
  agentspace start

Starts the daemon and the default profile's Chromium. The browser has windows
when DISPLAY or WAYLAND_DISPLAY is set; AGENTSPACE_HEADLESS=1 or 0 overrides it.
Other commands start the daemon on demand.
`,
  stop: `agentspace stop - Stop agentspace

Usage:
  agentspace stop

Closes every agentspace browser and stops the daemon. Agent Spaces are kept and
reopen empty next time.
`,
  status: `agentspace status - Show agentspace state

Usage:
  agentspace status
`,
  open: `agentspace open - Open a URL for yourself

Usage:
  agentspace open <url>

Opens the URL in a new window of the default profile. The window becomes a user
Space that agents can only use after claiming it.
`,
  panel: `agentspace panel - Open the Spaces control panel

Usage:
  agentspace panel

Lists every Space and lets you take control of an agent Space or return it.
Prints the panel URL and opens it in a window when a display is available.
`,
  profiles: `agentspace profiles - Manage browser profiles

Usage:
  agentspace profiles
  agentspace profiles detect
  agentspace profiles import <browser> [<profile-dir>...] [--replace]
                             [--set-default-browser]

Each profile is a separate Chromium data directory. \`import\` copies profiles
from another browser on this machine into new agentspace profiles.

Browsers: chrome, chromium, edge, brave

Import options:
  <profile-dir>          Import only these source profile directories
                         (as listed by \`profiles detect\`); default: all
  --replace              Delete every existing agentspace profile first
  --set-default-browser  Register agentspace as the desktop default browser

Close the source browser first. Cookies encrypted with a desktop keyring cannot
be decrypted by agentspace, so some sites may ask you to sign in again.

Examples:
  agentspace profiles detect
  agentspace profiles import chrome Default "Profile 1"
  agentspace profiles import brave --replace
`,
  upgrade: `agentspace upgrade - Update agentspace

Usage:
  agentspace upgrade

Fast-forwards this installation from its git remote and restarts the daemon.
`,
  help: `agentspace help - Show help

Usage:
  agentspace help [command]
`,
};

function fail(message, code = 1) {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  process.exit(code);
}

function parseGlobal(argv) {
  let instance = DEFAULT_INSTANCE;
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (rest.length === 0 && (arg === "-i" || arg === "--instance")) {
      instance = argv[++index];
    } else if (rest.length === 0 && arg.startsWith("--instance=")) {
      instance = arg.slice("--instance=".length);
    } else {
      rest.push(arg);
    }
  }
  if (!validInstanceName(instance)) {
    fail("Invalid --instance value: use 1-64 letters, digits, '.', '_' or '-'", 2);
  }
  return { instance, rest };
}

function resolveSdk(sdkPath) {
  if (sdkPath === undefined) {
    if (!existsSync(BUNDLED_SDK)) fail(`Bundled SDK is missing: ${BUNDLED_SDK}. Run npm run build:sdk.`);
    return { path: BUNDLED_SDK, override: false };
  }
  const absolute = resolve(sdkPath);
  if (!existsSync(absolute)) fail(`--sdk-path does not exist: ${absolute}`);
  return { path: absolute, override: true };
}

function parseRunArgs(args) {
  const positional = [];
  let sdkPath;
  let code;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--sdk-path") {
      sdkPath = args[++index];
      if (sdkPath === undefined) fail("--sdk-path requires a path", 2);
    } else if (arg.startsWith("--sdk-path=")) {
      sdkPath = arg.slice("--sdk-path=".length);
    } else if (arg === "-e" || arg === "--eval") {
      code = args[++index];
      if (code === undefined) fail(`${arg} requires code`, 2);
    } else if (arg.startsWith("--eval=")) {
      code = arg.slice("--eval=".length);
    } else if (arg.startsWith("-") && arg !== "-") {
      fail(`Unknown option: ${arg}\n\n${TOPICS.run}`, 2);
    } else {
      positional.push(arg);
    }
  }
  return { sdkPath, code, positional };
}

function readStdin() {
  return new Promise((resolveText, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolveText(data));
    process.stdin.on("error", reject);
  });
}

async function call(instance, method, args = []) {
  const client = await DaemonClient.connect(instance);
  const response = await client.call(method, undefined, args);
  client.close();
  if (response.__egoError) fail(`${response.error} (${response.error_code})`);
  return response.value;
}

async function commandRun(instance, args) {
  const { sdkPath, code, positional } = parseRunArgs(args);
  if (positional.length > 1 || (positional.length === 1 && code !== undefined)) {
    fail(`Pass one script: a file, -e <code>, or stdin.\n\n${TOPICS.run}`, 2);
  }
  const sdk = resolveSdk(sdkPath);
  const request = { mode: "script", sdkPath: sdk.path };
  if (code !== undefined) {
    request.code = code;
  } else if (positional.length === 1 && positional[0] !== "-") {
    const file = resolve(positional[0]);
    if (!existsSync(file)) fail(`Script not found: ${file}`);
    request.code = readFileSync(file, "utf8");
  } else if (process.stdin.isTTY && positional.length === 0) {
    request.mode = "repl";
  } else {
    request.code = await readStdin();
    if (!request.code.trim()) fail("No script on stdin.", 2);
  }
  return runInHelper(instance, request);
}

// The script runs in the daemon's Node helper; relay its stdio and exit code.
async function runInHelper(instance, request) {
  let socket;
  try {
    socket = await connectDaemon(instance);
  } catch (error) {
    fail(error.message);
  }
  const wire = new LineSocket(socket);
  const exitCode = await new Promise((resolveExit) => {
    wire.onMessage((message) => {
      if (message.op === "stdout") process.stdout.write(Buffer.from(message.data, "base64"));
      else if (message.op === "stderr") process.stderr.write(Buffer.from(message.data, "base64"));
      else if (message.op === "exit") resolveExit(message.code);
    });
    wire.onClose(() => {
      process.stderr.write(
        "agentspace closed the connection before the script finished. It may have quit or restarted; run the script again.\n",
      );
      resolveExit(1);
    });
    wire.send({ op: "run", ...request });
    if (request.mode === "repl") {
      process.stdin.on("data", (chunk) => wire.send({ op: "stdin", data: chunk.toString("base64") }));
      process.stdin.on("end", () => wire.send({ op: "stdin", end: true }));
    }
  });
  process.stdout.write("", () => process.exit(exitCode));
}

function commandGuide(args) {
  const { sdkPath, code, positional } = parseRunArgs(args);
  if (code !== undefined || positional.length > 0) fail(TOPICS.guide, 2);
  const sdk = resolveSdk(sdkPath);
  const guide = join(dirname(sdk.path), "ego-browser", "SKILL.md");
  if (!existsSync(guide)) fail(`Usage guide not found: ${guide}`);
  if (sdk.override) process.stderr.write(`[agentspace:guide] source=${guide} (not the bundled guide)\n`);
  process.stdout.write(readFileSync(guide, "utf8"));
}

async function commandProfiles(instance, args) {
  const [sub, ...rest] = args;
  const paths = servicePaths(instance);
  if (sub === undefined) {
    for (const profile of new ProfileStore(paths.profilesFile).list()) {
      process.stdout.write(`${profile.isDefault ? "*" : " "} ${profile.id}\t${profile.name}\n`);
    }
    return;
  }
  const importer = await import("./importer.mjs");
  if (sub === "detect") {
    const browsers = importer.detectBrowsers();
    if (browsers.length === 0) {
      process.stdout.write("No importable browsers were detected.\n");
      return;
    }
    for (const browser of browsers) {
      process.stdout.write(`${browser.id} (${browser.label}) ${browser.root}\n`);
      for (const profile of browser.profiles) process.stdout.write(`  ${profile.dir}\t${profile.name}\n`);
    }
    return;
  }
  if (sub !== "import") fail(`Unknown profiles command: ${sub}\n\n${TOPICS.profiles}`, 2);
  let options;
  try {
    options = importer.parseImportArgs(rest);
  } catch (error) {
    fail(`${error.message}\n\n${TOPICS.profiles}`, 2);
  }
  const running = await daemonRunning(paths);
  if (running && options.replace) await call(instance, "stopBrowsers");
  let imported;
  try {
    imported = importer.importProfiles(paths, options);
  } catch (error) {
    fail(`Import failed; existing profiles were kept. ${error.message}`);
  }
  if (running) await call(instance, "reloadProfiles");
  for (const profile of imported) {
    process.stdout.write(`Imported ${profile.source} as ${JSON.stringify(profile.id)} (${profile.name})\n`);
  }
  if (options.setDefaultBrowser) process.stdout.write(`${importer.setDefaultBrowser()}\n`);
}

async function daemonRunning(paths) {
  const { socketAlive } = await import("./daemon.mjs");
  return existsSync(paths.socketPath) && socketAlive(paths.socketPath);
}

async function main() {
  const { instance, rest } = parseGlobal(process.argv.slice(2));
  const [command, ...args] = rest;
  if (args.includes("--help") || args.includes("-h")) {
    const topic = TOPICS[command];
    if (topic) {
      process.stdout.write(topic);
      return;
    }
  }
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(MAIN_HELP);
      return;
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "help": {
      if (args.length === 0) {
        process.stdout.write(MAIN_HELP);
        return;
      }
      const topic = TOPICS[args[0]];
      if (!topic) fail(`No help for: ${args[0]}`, 2);
      process.stdout.write(topic);
      return;
    }
    case "run":
      return commandRun(instance, args);
    case "guide":
      return commandGuide(args);
    case "profiles":
      return commandProfiles(instance, args);
    case "upgrade": {
      const result = await upgrade().catch((error) => fail(error.message));
      if (!result.updated) {
        process.stdout.write(`agentspace ${VERSION} is up to date (${result.after}).\n`);
        return;
      }
      process.stdout.write(`agentspace updated ${result.before} -> ${result.after}.\n`);
      if (await daemonRunning(servicePaths(instance))) {
        await call(instance, "shutdown");
        process.stdout.write("Stopped the daemon; it starts again on the next command.\n");
      }
      return;
    }
    case "daemon": {
      const { runDaemon } = await import("./daemon.mjs");
      await runDaemon(instance);
      return;
    }
    case "start": {
      const status = await call(instance, "start");
      const browsers = status.browsers.map((browser) => `${browser.profileId}${browser.headless ? " (headless)" : ""}`);
      process.stdout.write(`agentspace ${VERSION} is running. Browsers: ${browsers.join(", ")}. Panel: ${status.panel}\n`);
      return;
    }
    case "stop": {
      if (!(await daemonRunning(servicePaths(instance)))) {
        process.stdout.write("agentspace is not running.\n");
        return;
      }
      await call(instance, "shutdown");
      process.stdout.write("agentspace stopped.\n");
      return;
    }
    case "status": {
      if (!(await daemonRunning(servicePaths(instance)))) {
        process.stdout.write("agentspace is not running.\n");
        return;
      }
      process.stdout.write(`${JSON.stringify(await call(instance, "status"), null, 2)}\n`);
      return;
    }
    case "open": {
      if (args.length !== 1) fail(TOPICS.open, 2);
      process.stdout.write(`${await call(instance, "openUrl", [args[0]])}\n`);
      return;
    }
    case "panel": {
      const result = await call(instance, "openPanel");
      process.stdout.write(`${result.url}\n`);
      return;
    }
    default:
      fail(`Unknown command: ${command}\nRun \`agentspace help\` for the command list.`, 2);
  }
}

await main();
