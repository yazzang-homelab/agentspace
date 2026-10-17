// Minimal Chrome DevTools Protocol client over the Node.js global WebSocket.

export class CdpConnection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closed = false;
  #closeListeners = new Set();

  static async connect(url, { timeoutMs = 10_000 } = {}) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`CDP connect timed out: ${url}`));
        try {
          ws.close();
        } catch {}
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${event?.message || url}`));
      });
    });
    return new CdpConnection(ws);
  }

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#onMessage(event.data));
    ws.addEventListener("close", () => this.#onClose());
    ws.addEventListener("error", () => this.#onClose());
  }

  get closed() {
    return this.#closed;
  }

  /** Send a raw, already-serialized CDP frame (used by the per-client proxy). */
  sendRaw(text) {
    if (this.#closed) throw new Error("CDP connection closed");
    this.#ws.send(text);
  }

  send(method, params = {}, sessionId = undefined, { timeoutMs = 30_000 } = {}) {
    if (this.#closed) {
      return Promise.reject(new Error("CDP connection closed"));
    }
    const id = this.#nextId++;
    const frame = { id, method, params };
    if (sessionId) frame.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(id);
              reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this.#pending.set(id, { resolve, reject, timer, method });
      this.#ws.send(JSON.stringify(frame));
    });
  }

  /** Subscribe to every decoded frame that is not a reply to our own send(). */
  onMessage(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener) {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close() {
    if (this.#closed) return;
    try {
      this.#ws.close();
    } catch {}
    this.#onClose();
  }

  #onMessage(data) {
    const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (Object.hasOwn(message, "id")) {
      const entry = this.#pending.get(message.id);
      if (entry) {
        this.#pending.delete(message.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(
            `${entry.method}: ${message.error.message || JSON.stringify(message.error)}`,
          );
          error.cdpError = message.error;
          entry.reject(error);
        } else {
          entry.resolve(message.result || {});
        }
        return;
      }
    }
    for (const listener of this.#listeners) {
      try {
        listener(message, text);
      } catch {}
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error("CDP connection closed"));
    }
    this.#pending.clear();
    for (const listener of this.#closeListeners) {
      try {
        listener();
      } catch {}
    }
  }
}
