// Raw CDP bridge for one task space.
//
// `ego.sendCDPMessage()` must only expose the selected task space's tabs. This
// channel enforces that boundary on top of a browser-level DevTools WebSocket:
//
// - one upstream connection per task space that outlives a single
//   `agentspace run` invocation, so a JavaScript dialog opened in one round
//   stays open (and Agent-owned) for the next round;
// - request ids are rewritten per client, sessions are owned by the client
//   that attached them, and browser-level Target events are filtered to the
//   task space's targets;
// - Target.createTarget is redirected into the task space window.

import { CdpConnection } from "./cdp.mjs";

const BLOCKED_BROWSER_METHODS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Target.attachToBrowserTarget",
  "Target.exposeDevToolsProtocol",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.setAutoAttach",
  "Target.setRemoteLocations",
]);

const TARGET_SCOPED_METHODS = new Set([
  "Target.attachToTarget",
  "Target.activateTarget",
  "Target.closeTarget",
  "Target.getTargetInfo",
  "Browser.getWindowForTarget",
]);

export class SpaceChannel {
  #upstream = null;
  #connecting = null;
  #queue = Promise.resolve();
  #nextId = 1;
  #pending = new Map(); // upstream id -> { client, clientId, method, params }
  #sessionOwner = new Map(); // sessionId -> client | null (orphaned)
  #sessionTarget = new Map(); // sessionId -> targetId
  #pendingAttach = new Map(); // targetId -> client[]
  #discoverClients = new Set();
  #reportedTargets = new Map(); // client -> Set<targetId>
  #dialogs = new Map(); // targetId -> { params, sessionId }
  #deferredEnables = new Map(); // targetId -> [{ sessionId, method, params }]
  #downloads = new Map(); // guid -> client
  #closed = false;

  constructor({ host, spaceId, isMember, onActivate, createTab, onClose }) {
    this.host = host;
    this.spaceId = spaceId;
    this.isMember = isMember;
    this.onActivate = onActivate;
    this.createTab = createTab;
    this.onClose = onClose;
  }

  async #connection() {
    if (this.#upstream && !this.#upstream.closed) return this.#upstream;
    this.#connecting ||= CdpConnection.connect(this.host.wsUrl)
      .then((conn) => {
        this.#upstream = conn;
        conn.onMessage((message) => {
          this.#queue = this.#queue.then(() => this.#fromBrowser(message)).catch(() => {});
        });
        conn.onClose(() => this.close());
        return conn;
      })
      .finally(() => {
        this.#connecting = null;
      });
    return this.#connecting;
  }

  /** Forward one JSON-encoded CDP command from a client. */
  async fromClient(client, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      client.sendCdpError("CDP message must be valid JSON", "EGO_CDP_SEND_FAILED");
      return;
    }
    if (!message || typeof message.method !== "string" || !Number.isInteger(message.id)) {
      client.sendCdpError("CDP message requires an integer id and a method", "EGO_CDP_SEND_FAILED");
      return;
    }
    const reply = (result) => client.sendCdp(JSON.stringify({ id: message.id, result, ...sid(message) }));
    const fail = (errorMessage, code = -32000) =>
      client.sendCdp(
        JSON.stringify({ id: message.id, error: { code, message: errorMessage }, ...sid(message) }),
      );
    try {
      const upstream = await this.#connection();
      const { method, params = {}, sessionId } = message;
      if (!sessionId) {
        if (BLOCKED_BROWSER_METHODS.has(method)) {
          fail(`${method} is not available inside this task space`);
          return;
        }
        if (method === "Target.createTarget") {
          const created = await this.createTab(params.url || "about:blank", {
            background: params.background === true,
          });
          reply({ targetId: created.targetId });
          return;
        }
        if (TARGET_SCOPED_METHODS.has(method)) {
          const info = this.host.target(params.targetId);
          if (!info || !(await this.isMember(info))) {
            fail(`No target with given id found`);
            return;
          }
          if (method === "Target.activateTarget") this.onActivate(params.targetId);
          if (method === "Target.attachToTarget") {
            const waiting = this.#pendingAttach.get(params.targetId) || [];
            waiting.push(client);
            this.#pendingAttach.set(params.targetId, waiting);
          }
        }
        if (method === "Target.setDiscoverTargets") {
          if (params.discover) this.#discoverClients.add(client);
          else this.#discoverClients.delete(client);
          // Discovery is per upstream connection; keep it on while any client wants it.
          if (!params.discover && this.#discoverClients.size > 0) {
            reply({});
            return;
          }
          if (params.discover) this.#reportedTargets.set(client, new Set());
        }
      } else {
        const owner = this.#sessionOwner.get(sessionId);
        if (owner !== client) {
          fail(`Session with given id not found.`);
          return;
        }
        const targetId = this.#sessionTarget.get(sessionId);
        const dialog = targetId && this.#dialogs.get(targetId);
        if (dialog && dialog.sessionId !== sessionId) {
          // The renderer is blocked by a dialog this session never saw.
          if (method === "Page.enable") {
            const deferred = this.#deferredEnables.get(targetId) || [];
            deferred.push({ sessionId, method, params });
            this.#deferredEnables.set(targetId, deferred);
            reply({});
            client.sendCdp(
              JSON.stringify({ method: "Page.javascriptDialogOpening", params: dialog.params, sessionId }),
            );
            return;
          }
          if (method === "Page.handleJavaScriptDialog") {
            this.#send(upstream, client, message, dialog.sessionId);
            return;
          }
        }
      }
      this.#send(upstream, client, message, message.sessionId);
    } catch (error) {
      fail(error?.message || String(error));
    }
  }

  #send(upstream, client, message, sessionId) {
    const id = this.#nextId++;
    this.#pending.set(id, { client, clientId: message.id, clientSessionId: message.sessionId, method: message.method, params: message.params || {} });
    const frame = { id, method: message.method, params: message.params || {} };
    if (sessionId) frame.sessionId = sessionId;
    upstream.sendRaw(JSON.stringify(frame));
  }

  async #fromBrowser(message) {
    if (Object.hasOwn(message, "id")) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      this.#pending.delete(message.id);
      if (entry.method === "Target.getTargets" && message.result?.targetInfos) {
        const visible = [];
        for (const info of message.result.targetInfos) {
          if (await this.isMember(info)) visible.push(info);
        }
        message.result.targetInfos = visible;
      }
      if (entry.method === "Target.attachToTarget" && message.result?.sessionId) {
        this.#claimSession(message.result.sessionId, entry.params.targetId, entry.client);
        const waiting = this.#pendingAttach.get(entry.params.targetId);
        if (waiting) {
          waiting.splice(waiting.indexOf(entry.client), 1);
          if (waiting.length === 0) this.#pendingAttach.delete(entry.params.targetId);
        }
      }
      if (entry.method === "Target.detachFromTarget" && !message.error) {
        this.#releaseSession(entry.params.sessionId);
      }
      const reply = { ...message, id: entry.clientId };
      if (entry.clientSessionId) reply.sessionId = entry.clientSessionId;
      else delete reply.sessionId;
      entry.client.sendCdp(JSON.stringify(reply));
      return;
    }

    const { method, params = {}, sessionId } = message;
    if (sessionId) {
      this.#trackSessionEvent(message);
      if (method === "Target.attachedToTarget") {
        const owner = this.#sessionOwner.get(sessionId);
        this.#claimSession(params.sessionId, params.targetInfo?.targetId, owner ?? null);
      }
      if (method === "Target.detachedFromTarget") this.#releaseSession(params.sessionId);
      const owner = this.#sessionOwner.get(sessionId);
      if (owner) owner.sendCdp(JSON.stringify(message));
      return;
    }

    if (method === "Target.attachedToTarget") {
      const targetId = params.targetInfo?.targetId;
      const waiting = this.#pendingAttach.get(targetId);
      const owner = waiting?.[0];
      if (owner) {
        this.#claimSession(params.sessionId, targetId, owner);
        owner.sendCdp(JSON.stringify(message));
      }
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const owner = this.#sessionOwner.get(params.sessionId);
      this.#releaseSession(params.sessionId);
      if (owner) owner.sendCdp(JSON.stringify(message));
      return;
    }
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged" || method === "Target.targetCrashed") {
      const info = params.targetInfo || this.host.target(params.targetId);
      const member = info ? await this.isMember(info) : false;
      for (const client of this.#discoverClients) {
        const reported = this.#reportedTargets.get(client);
        if (member) {
          reported?.add(info.targetId);
          client.sendCdp(JSON.stringify(message));
        }
      }
      return;
    }
    if (method === "Target.targetDestroyed") {
      for (const client of this.#discoverClients) {
        const reported = this.#reportedTargets.get(client);
        if (reported?.delete(params.targetId)) client.sendCdp(JSON.stringify(message));
      }
      return;
    }
    if (method === "Browser.downloadWillBegin") {
      const owner = await this.#downloadOwner(params.frameId);
      if (owner) {
        this.#downloads.set(params.guid, owner);
        owner.sendCdp(JSON.stringify(message));
      }
      return;
    }
    if (method === "Browser.downloadProgress") {
      const owner = this.#downloads.get(params.guid);
      if (owner) {
        owner.sendCdp(JSON.stringify(message));
        if (params.state !== "inProgress") this.#downloads.delete(params.guid);
      }
      return;
    }
    // Other browser-level events reach every live client of this space.
    for (const client of this.#clients()) client.sendCdp(JSON.stringify(message));
  }

  async #downloadOwner(frameId) {
    // A main-frame download reports the page target id as its frame id.
    for (const [sessionId, targetId] of this.#sessionTarget) {
      const owner = this.#sessionOwner.get(sessionId);
      if (owner && targetId === frameId) return owner;
    }
    const info = this.host.target(frameId);
    if (info && (await this.isMember(info))) return [...this.#clients()].at(-1) || null;
    // Subframe downloads: fall back to the most recent client of this space.
    return [...this.#clients()].at(-1) || null;
  }

  #clients() {
    const clients = new Set();
    for (const owner of this.#sessionOwner.values()) if (owner) clients.add(owner);
    for (const client of this.#discoverClients) clients.add(client);
    for (const entry of this.#pending.values()) clients.add(entry.client);
    return clients;
  }

  #claimSession(sessionId, targetId, client) {
    if (!sessionId) return;
    this.#sessionOwner.set(sessionId, client);
    if (targetId) this.#sessionTarget.set(sessionId, targetId);
  }

  #releaseSession(sessionId) {
    this.#sessionOwner.delete(sessionId);
    this.#sessionTarget.delete(sessionId);
  }

  #trackSessionEvent(message) {
    const targetId = this.#sessionTarget.get(message.sessionId);
    if (!targetId) return;
    if (message.method === "Page.javascriptDialogOpening") {
      this.#dialogs.set(targetId, { params: message.params, sessionId: message.sessionId });
    } else if (message.method === "Page.javascriptDialogClosed") {
      const dialog = this.#dialogs.get(targetId);
      if (dialog?.sessionId === message.sessionId) {
        this.#dialogs.delete(targetId);
        this.#afterDialogClosed(targetId);
      }
    }
  }

  #afterDialogClosed(targetId) {
    const deferred = this.#deferredEnables.get(targetId) || [];
    this.#deferredEnables.delete(targetId);
    const upstream = this.#upstream;
    if (!upstream || upstream.closed) return;
    for (const entry of deferred) {
      if (!this.#sessionOwner.get(entry.sessionId)) continue;
      upstream.sendRaw(JSON.stringify({ id: this.#nextId++, method: entry.method, params: entry.params, sessionId: entry.sessionId }));
    }
    // Orphaned sessions only stayed attached to keep the dialog alive.
    for (const [sessionId, owner] of this.#sessionOwner) {
      if (owner === null && this.#sessionTarget.get(sessionId) === targetId) {
        upstream.sendRaw(JSON.stringify({ id: this.#nextId++, method: "Target.detachFromTarget", params: { sessionId } }));
        this.#releaseSession(sessionId);
      }
    }
  }

  /** A client disconnected: detach its sessions unless one holds an open dialog. */
  dropClient(client) {
    this.#discoverClients.delete(client);
    this.#reportedTargets.delete(client);
    for (const [id, entry] of this.#pending) if (entry.client === client) this.#pending.delete(id);
    for (const [guid, owner] of this.#downloads) if (owner === client) this.#downloads.delete(guid);
    for (const [targetId, waiting] of this.#pendingAttach) {
      const next = waiting.filter((item) => item !== client);
      if (next.length) this.#pendingAttach.set(targetId, next);
      else this.#pendingAttach.delete(targetId);
    }
    const upstream = this.#upstream;
    for (const [sessionId, owner] of [...this.#sessionOwner]) {
      if (owner !== client) continue;
      const targetId = this.#sessionTarget.get(sessionId);
      const dialog = targetId && this.#dialogs.get(targetId);
      if (dialog && dialog.sessionId === sessionId) {
        this.#sessionOwner.set(sessionId, null);
        continue;
      }
      this.#releaseSession(sessionId);
      if (upstream && !upstream.closed) {
        upstream.sendRaw(JSON.stringify({ id: this.#nextId++, method: "Target.detachFromTarget", params: { sessionId } }));
      }
    }
    if (upstream && !upstream.closed && this.#discoverClients.size === 0) {
      upstream.sendRaw(JSON.stringify({ id: this.#nextId++, method: "Target.setDiscoverTargets", params: { discover: false } }));
    }
  }

  /** Whether a Page has a dialog that a later round still has to handle. */
  openDialog(targetId) {
    return this.#dialogs.get(targetId)?.params;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#upstream?.close();
    this.onClose?.();
  }
}

function sid(message) {
  return message.sessionId ? { sessionId: message.sessionId } : {};
}
