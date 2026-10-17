// One Chromium process per agentspace profile, plus the daemon's own browser-level
// CDP connection used for target discovery, window membership and snapshots.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CdpConnection } from "./cdp.mjs";
import { launchChromium } from "./chromium.mjs";
import { ensureDir } from "./paths.mjs";

const WINDOW_CACHE_MS = 1_000;

export class BrowserHost {
  profileId;
  userDataDir;
  #logFile;
  #conn = null;
  #starting = null;
  #targets = new Map();
  #order = new Map();
  #sequence = 0;
  #windowCache = new Map();
  #pageSessions = new Map();
  #sessionTargets = new Map();
  #childSessions = new Map();
  #targetListeners = new Set();
  #exitListeners = new Set();
  wsUrl = null;
  headless = false;
  binary = null;

  constructor({ profileId, profilesDir, logFile }) {
    this.profileId = profileId;
    this.userDataDir = ensureDir(join(profilesDir, profileId));
    this.#logFile = logFile;
  }

  get running() {
    return Boolean(this.#conn && !this.#conn.closed);
  }

  async ensureStarted() {
    if (this.running) return this;
    this.#starting ||= this.#start().finally(() => {
      this.#starting = null;
    });
    await this.#starting;
    return this;
  }

  async #start() {
    let wsUrl = await this.#existingBrowser();
    if (!wsUrl) {
      const launched = await launchChromium({
        userDataDir: this.userDataDir,
        logFile: this.#logFile,
      });
      wsUrl = launched.wsUrl;
      this.headless = launched.headless;
      this.binary = launched.binary;
    }
    const conn = await CdpConnection.connect(wsUrl);
    this.wsUrl = wsUrl;
    this.#conn = conn;
    this.#targets.clear();
    this.#windowCache.clear();
    this.#pageSessions.clear();
    this.#sessionTargets.clear();
    this.#childSessions.clear();
    conn.onMessage((message) => this.#onEvent(message));
    conn.onClose(() => {
      for (const listener of this.#exitListeners) listener(this);
    });
    await conn.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos = [] } = await conn.send("Target.getTargets");
    for (const info of targetInfos) this.#remember(info);
  }

  // Reuse a browser left running by an earlier daemon on the same profile.
  async #existingBrowser() {
    const portFile = join(this.userDataDir, "DevToolsActivePort");
    if (!existsSync(portFile)) return null;
    const [port, path] = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
    if (!port || !path) return null;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      });
      const version = await response.json();
      if (!version.webSocketDebuggerUrl?.endsWith(path)) return null;
      this.headless = /Headless/i.test(version["User-Agent"] || "");
      return `ws://127.0.0.1:${port}${path}`;
    } catch {
      return null;
    }
  }

  onTargetEvent(listener) {
    this.#targetListeners.add(listener);
    return () => this.#targetListeners.delete(listener);
  }

  onExit(listener) {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  send(method, params = {}, sessionId = undefined, options = {}) {
    if (!this.running) return Promise.reject(new Error("browser is not running"));
    return this.#conn.send(method, params, sessionId, options);
  }

  #remember(info) {
    if (!this.#order.has(info.targetId)) this.#order.set(info.targetId, this.#sequence++);
    this.#targets.set(info.targetId, info);
  }

  #onEvent(message) {
    const { method, params = {} } = message;
    if (!message.sessionId) {
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
        this.#remember(params.targetInfo);
      } else if (method === "Target.targetDestroyed") {
        this.#targets.delete(params.targetId);
        this.#order.delete(params.targetId);
        this.#windowCache.delete(params.targetId);
        const sessionId = this.#pageSessions.get(params.targetId);
        if (sessionId) this.#dropSession(sessionId);
      } else if (method === "Target.detachedFromTarget") {
        this.#dropSession(params.sessionId);
      }
      if (method?.startsWith("Target.")) {
        for (const listener of this.#targetListeners) listener(message);
      }
      return;
    }
    // Child sessions of the daemon's page sessions (OOPIFs for snapshots).
    if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe") {
      const parentTarget = this.#sessionTargets.get(message.sessionId);
      if (parentTarget) {
        this.#sessionTargets.set(params.sessionId, params.targetInfo.targetId);
        const children = this.#childSessions.get(parentTarget) || new Map();
        children.set(params.targetInfo.targetId, params.sessionId);
        this.#childSessions.set(parentTarget, children);
        // Nested OOPIFs report through the child session.
        this.#conn
          .send(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            params.sessionId,
          )
          .catch(() => {});
        this.#childSessions.set(params.targetInfo.targetId, children);
      }
    } else if (method === "Target.detachedFromTarget") {
      this.#dropSession(params.sessionId);
    }
  }

  #dropSession(sessionId) {
    const targetId = this.#sessionTargets.get(sessionId);
    if (!targetId) return;
    this.#sessionTargets.delete(sessionId);
    if (this.#pageSessions.get(targetId) === sessionId) {
      this.#pageSessions.delete(targetId);
      this.#childSessions.delete(targetId);
    }
    for (const children of this.#childSessions.values()) {
      for (const [frameId, child] of children) {
        if (child === sessionId) children.delete(frameId);
      }
    }
  }

  target(targetId) {
    return this.#targets.get(targetId);
  }

  pages() {
    return [...this.#targets.values()]
      .filter((info) => info.type === "page")
      .sort((a, b) => (this.#order.get(a.targetId) ?? 0) - (this.#order.get(b.targetId) ?? 0));
  }

  /** Browser window that owns a target, or undefined when it has none. */
  async windowOf(targetId, { fresh = false } = {}) {
    const cached = this.#windowCache.get(targetId);
    if (!fresh && cached && Date.now() - cached.at < WINDOW_CACHE_MS) return cached.windowId;
    try {
      const { windowId } = await this.send("Browser.getWindowForTarget", { targetId });
      this.#windowCache.set(targetId, { windowId, at: Date.now() });
      return windowId;
    } catch {
      this.#windowCache.delete(targetId);
      return undefined;
    }
  }

  /** Daemon-owned flat session for one page target, with OOPIF auto-attach. */
  async pageSession(targetId) {
    const existing = this.#pageSessions.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.#pageSessions.set(targetId, sessionId);
    this.#sessionTargets.set(sessionId, targetId);
    await this.send(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      sessionId,
    ).catch(() => {});
    return sessionId;
  }

  /** Session handle in the shape lib/snapshot.mjs expects. */
  async snapshotPage(targetId) {
    const sessionId = await this.pageSession(targetId);
    const childSessions = new Map();
    const collect = (parent) => {
      for (const [frameId, child] of this.#childSessions.get(parent) || []) {
        if (childSessions.has(frameId)) continue;
        childSessions.set(frameId, child);
        collect(frameId);
      }
    };
    collect(targetId);
    return {
      sessionId,
      childSessions,
      send: (method, params, session) => this.send(method, params, session),
    };
  }

  async stop() {
    if (!this.running) return;
    try {
      await this.send("Browser.close", {}, undefined, { timeoutMs: 5_000 });
    } catch {}
    this.#conn?.close();
  }
}
