// The Node helper process behind `ego-browser nodejs`. It is a child of the
// long-lived daemon (so the SDK's runtime instance id, derived from the parent
// pid, is stable across rounds),
// it does not inherit the caller's shell environment or working directory, and
// it evaluates the script with the ego bindings and SDK installed on globalThis.
//
//   node node-host.mjs <script|repl> <serverName> <sdkPath>   (script on stdin)

import { Console } from "node:console";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import { createEgoBindings, DaemonClient } from "./ego-client.mjs";

const MAX_REPL_INPUT = 64 * 1024 * 1024;
const SCRIPT_NAME = "ego-browser-script.js";

async function prepare({ serverName, sdkPath }) {
  const client = await DaemonClient.connect(serverName);
  globalThis.ego = createEgoBindings(client);
  let sdk = null;
  if (sdkPath) sdk = await import(pathToFileURL(sdkPath).href);
  return { client, sdk };
}

/** Compile like a module body: top-level await and dynamic import work. */
export function compileScript(code) {
  const wrapped = `(async function () {\n"use strict";\n${code}\n})`;
  try {
    const script = new vm.Script(wrapped, {
      filename: SCRIPT_NAME,
      importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    return script.runInThisContext();
  } catch (error) {
    if (error instanceof SyntaxError) throw describeSyntaxError(error, code);
    throw error;
  }
}

// V8 reports `<file>:<line>\n<source>\n<caret>` at the top of the stack.
function describeSyntaxError(error, code) {
  const lines = String(error.stack || "").split("\n");
  const header = new RegExp(`${SCRIPT_NAME.replace(".", "\\.")}:(\\d+)`).exec(lines[0] || "");
  if (!header) return error;
  const userLine = Number(header[1]) - 2;
  const caretLine = lines[2] || "";
  const column = Math.max(0, caretLine.indexOf("^"));
  const source = code.split(/\r?\n/)[userLine - 1] ?? "";
  if (userLine < 1) return error;
  const prefix = `${userLine} | `;
  const described = new SyntaxError(
    `Browser script syntax error at line ${userLine}, column ${column + 1}: ${error.message}\n` +
      `${prefix}${source}\n${" ".repeat(prefix.length + column)}^`,
  );
  described.cause = error;
  return described;
}

function formatError(error) {
  if (error instanceof SyntaxError && String(error.message).startsWith("Browser script syntax error")) {
    return `SyntaxError: ${error.message}`;
  }
  const code = error?.error_code ? ` [${error.error_code}]` : "";
  return `${error?.stack || error?.message || String(error)}${code}`;
}

async function dispose(sdk, client) {
  try {
    await sdk?.disposeEgoSdk?.();
  } catch {}
  client.close();
}

/** Run one script and terminate the process with its exit code. */
export async function runScript({ code, serverName, sdkPath }) {
  let prepared;
  try {
    prepared = await prepare({ serverName, sdkPath });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  const { client, sdk } = prepared;
  try {
    const fn = compileScript(code);
    await fn();
  } catch (error) {
    process.stderr.write(`${formatError(error)}\n`);
    await dispose(sdk, client);
    // `exit` flushes the SDK output buffer as a thrown completion.
    process.exit(1);
  }
  await dispose(sdk, client);
  // A clean completion flushes the SDK output buffer (and any owned hard-stop
  // guidance) through beforeExit before the process ends, even if the script
  // left timers or listeners behind.
  process.emit("beforeExit", 0);
  process.exit(process.exitCode ?? 0);
}

/** Interactive REPL with `.cell` / `.end` / `.cancel` / `.exit`. */
export async function runRepl({ serverName, sdkPath }) {
  const { client, sdk } = await prepare({ serverName, sdkPath });
  // The SDK buffers round output until process exit; a REPL prints per input.
  const realConsole = new Console({ stdout: process.stdout, stderr: process.stderr });
  Object.defineProperty(globalThis, "console", { value: realConsole, writable: true, configurable: true });
  if (typeof globalThis.cliLog === "function") {
    Object.defineProperty(globalThis, "cliLog", {
      value: (...args) => realConsole.log(...args),
      writable: true,
      configurable: true,
    });
  }
  process.stdout.write("ego-browser nodejs REPL. Type .exit to quit, .cell/.end for multiline.\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "repl> " });
  let cell = null;
  const evaluate = async (source) => {
    if (Buffer.byteLength(source) > MAX_REPL_INPUT) {
      realConsole.error("REPL input exceeds the 64 MiB limit.");
      return;
    }
    try {
      // Without await, run as a classic script so declarations persist
      // across inputs; with await, run inside an async function.
      let value;
      if (!/\bawait\b/.test(source)) {
        value = vm.runInThisContext(source, {
          filename: SCRIPT_NAME,
          importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
        });
      } else {
        try {
          value = await compileScript(`return (${source}\n);`)();
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          value = await compileScript(source)();
        }
      }
      if (value !== undefined) realConsole.log(value);
    } catch (error) {
      realConsole.error(formatError(error));
    }
  };
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (cell !== null) {
      if (trimmed === ".end") {
        const source = cell.join("\n");
        cell = null;
        await evaluate(source);
      } else if (trimmed === ".cancel") {
        cell = null;
      } else {
        cell.push(line);
      }
    } else if (trimmed === ".exit") {
      break;
    } else if (trimmed === ".cell") {
      cell = [];
    } else if (trimmed) {
      await evaluate(line);
    }
    rl.setPrompt(cell !== null ? "...> " : "repl> ");
    rl.prompt();
  }
  rl.close();
  await dispose(sdk, client);
  process.exit(0);
}

function readAll(stream) {
  return new Promise((resolveText, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolveText(data));
    stream.on("error", reject);
  });
}

const [mode, serverName, sdkPath] = process.argv.slice(2);
if (mode === "script") {
  await runScript({ code: await readAll(process.stdin), serverName, sdkPath });
} else if (mode === "repl") {
  await runRepl({ serverName, sdkPath });
}
