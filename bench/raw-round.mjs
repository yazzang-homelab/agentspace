// Baseline: one "computer use" round against plain Chromium over raw CDP.
// Like a screenshot-driven agent tool, each round acts with mouse/keyboard
// input at element coordinates, waits for the expected state, and returns a
// screenshot as the observation. The coordinates come from the DOM, standing in
// for the model reading them off the previous screenshot.
//
//   node raw-round.mjs <browserWsUrl> <stateFile> <round> <baseUrl>
// Prints one JSON line: { screenshotBytes, width, height, htmlChars, summary? }

import { readFileSync, writeFileSync, existsSync } from "node:fs";

import { CdpConnection } from "../lib/cdp.mjs";

const [wsUrl, stateFile, roundArg, baseUrl] = process.argv.slice(2);
const round = Number(roundArg);
const conn = await CdpConnection.connect(wsUrl);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};

if (round === 1) {
  const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" });
  state.targetId = targetId;
  writeFileSync(stateFile, JSON.stringify(state));
}
const { sessionId } = await conn.send("Target.attachToTarget", { targetId: state.targetId, flatten: true });
const send = (method, params = {}) => conn.send(method, params, sessionId);
await send("Page.enable");
await send("Runtime.enable");

async function evaluate(expression) {
  const { result, exceptionDetails } = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

async function waitFor(expression, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${expression}`);
}

async function click(selector) {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
  const point = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function type(selector, text) {
  await click(selector);
  await send("Input.insertText", { text });
}

async function pressEnter() {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

const urlIs = (fragment) => `location.href.includes(${JSON.stringify(fragment)}) && document.readyState === "complete"`;

switch (round) {
  case 1:
    await send("Page.navigate", { url: `${baseUrl}/login` });
    await waitFor(urlIs("/login"));
    break;
  case 2:
    await type("input[name=user]", "agent");
    await type("input[name=pass]", "hunter2");
    await click("#login button");
    await waitFor(urlIs("/shop"));
    break;
  case 3:
    await type("input[name=q]", "keyboard");
    await pressEnter();
    await waitFor(urlIs("q=keyboard"));
    break;
  case 4:
    await click('button[data-name="Mechanical Keyboard K2"]');
    await waitFor(`document.getElementById("cart-count").textContent === "1"`);
    break;
  case 5:
    await click("#cart-link");
    await waitFor(urlIs("/cart"));
    await click("#checkout");
    await waitFor(urlIs("/checkout"));
    break;
  case 6:
    await type("input[name=name]", "Ada Lovelace");
    await type("textarea[name=address]", "12 Analytical Engine Way");
    await click('input[value="express"]');
    await click("input[name=agree]");
    await click("#checkout-form button");
    await waitFor(urlIs("/done"));
    break;
  default:
    throw new Error(`unknown round ${round}`);
}

const { data } = await send("Page.captureScreenshot", { format: "png" });
const metrics = await send("Page.getLayoutMetrics");
const viewport = metrics.cssVisualViewport;
const htmlChars = await evaluate("document.documentElement.outerHTML.length");
const summary = round === 6 ? await evaluate(`document.getElementById("summary").textContent`) : undefined;
await conn.send("Target.detachFromTarget", { sessionId });
conn.close();
console.log(
  JSON.stringify({
    screenshotBytes: Buffer.from(data, "base64").length,
    width: Math.round(viewport.clientWidth),
    height: Math.round(viewport.clientHeight),
    htmlChars,
    summary,
  }),
);
