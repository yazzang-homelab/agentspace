// Browser-side clipboard transactions for `page.keyboard.paste` on Linux.
//
// Chromium pastes from its own clipboard: the X11/Wayland selection in a
// desktop session, an in-memory clipboard when headless. A hidden helper tab
// on the daemon's loopback origin (a secure context with clipboard permission
// granted over CDP) saves the previous text/HTML, publishes the paste content,
// and restores the previous value only when nobody else wrote in between.

import { randomUUID } from "node:crypto";

const TRANSACTION_TTL_MS = 60_000;

export class BrowserClipboard {
  #host;
  #helperUrl;
  #targetId = null;
  #sessionId = null;
  #queue = Promise.resolve();
  #transactions = new Map();

  constructor(host, helperUrl) {
    this.#host = host;
    this.#helperUrl = helperUrl;
  }

  async #session() {
    if (this.#targetId && this.#host.target(this.#targetId) && this.#sessionId) return this.#sessionId;
    const origin = new URL(this.#helperUrl).origin;
    await this.#host.send("Browser.grantPermissions", {
      origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    const { targetId } = await this.#host.send("Target.createTarget", {
      url: this.#helperUrl,
      hidden: true,
      background: true,
    });
    this.#targetId = targetId;
    this.#sessionId = await this.#host.pageSession(targetId);
    await this.#host.send("Emulation.setFocusEmulationEnabled", { enabled: true }, this.#sessionId);
    // Wait for the helper document so navigator.clipboard is ready.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { result } = await this.#host.send(
        "Runtime.evaluate",
        { expression: "document.readyState === 'complete' && location.origin", returnByValue: true },
        this.#sessionId,
      );
      if (result?.value === origin) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.#sessionId;
  }

  async #evaluate(expression) {
    const sessionId = await this.#session();
    const response = await this.#host.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId,
    );
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  // One transaction at a time per browser: the clipboard is a single resource.
  #serialized(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  begin(content) {
    if (!content || typeof content.text !== "string" || (content.html !== undefined && typeof content.html !== "string")) {
      throw new TypeError("clipboard content requires { text, html? } strings");
    }
    return this.#serialized(async () => {
      const previous = await this.#evaluate(READ_CLIPBOARD);
      await this.#evaluate(writeClipboard(content));
      const written = await this.#evaluate(READ_CLIPBOARD);
      const transactionId = randomUUID();
      const timer = setTimeout(() => this.#transactions.delete(transactionId), TRANSACTION_TTL_MS);
      timer.unref();
      this.#transactions.set(transactionId, { previous, written, timer });
      return { transactionId };
    });
  }

  finish(transactionId) {
    const transaction = this.#transactions.get(transactionId);
    if (!transaction) throw new Error(`Unknown clipboard transaction: ${transactionId}`);
    this.#transactions.delete(transactionId);
    clearTimeout(transaction.timer);
    return this.#serialized(async () => {
      const current = await this.#evaluate(READ_CLIPBOARD);
      if (!sameContent(current, transaction.written)) return "changed";
      await this.#evaluate(writeClipboard(transaction.previous || { text: "" }));
      return "restored";
    });
  }
}

function sameContent(a, b) {
  return (a?.text ?? null) === (b?.text ?? null) && (a?.html ?? null) === (b?.html ?? null);
}

const READ_CLIPBOARD = `(async () => {
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch {
    return null;
  }
  const value = {};
  for (const item of items) {
    if (item.types.includes("text/plain") && value.text === undefined) {
      value.text = await (await item.getType("text/plain")).text();
    }
    if (item.types.includes("text/html") && value.html === undefined) {
      value.html = await (await item.getType("text/html")).text();
    }
  }
  return value.text === undefined && value.html === undefined ? null : value;
})()`;

function writeClipboard(content) {
  return `(async () => {
    const content = ${JSON.stringify(content)};
    const parts = { "text/plain": new Blob([content.text ?? ""], { type: "text/plain" }) };
    if (typeof content.html === "string") {
      parts["text/html"] = new Blob([content.html], { type: "text/html" });
    }
    await navigator.clipboard.write([new ClipboardItem(parts)]);
  })()`;
}
