// Newline-delimited JSON framing over a Unix domain socket.

export class LineSocket {
  #socket;
  #buffer = "";
  #listeners = new Set();
  #closeListeners = new Set();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => this.#onClose());
    socket.on("error", () => this.#onClose());
  }

  get socket() {
    return this.#socket;
  }

  get closed() {
    return this.#closed;
  }

  send(message) {
    if (this.#closed) return false;
    return this.#socket.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(listener) {
    this.#listeners.add(listener);
  }

  onClose(listener) {
    this.#closeListeners.add(listener);
  }

  close() {
    this.#socket.end();
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      for (const listener of this.#listeners) listener(message);
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}
