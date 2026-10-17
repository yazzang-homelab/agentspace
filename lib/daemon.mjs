// agentspace daemon. It owns Chromium
// (one process per profile), the task-space registry and the native-binding
// RPC surface that `agentspace run` exposes as `globalThis.ego`.

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { connect, createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as osConstants, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { BrowserHost } from "./browser-host.mjs";
import { SpaceChannel } from "./channel.mjs";
import { CODES, EgoError, toErrorResult } from "./errors.mjs";
import { ensureDir, servicePaths } from "./paths.mjs";
import { ProfileStore } from "./profiles.mjs";
import { BrowserClipboard } from "./clipboard.mjs";
import { captureSnapshot } from "./snapshot.mjs";
import { LineSocket } from "./wire.mjs";
import { renderPanel } from "./panel.mjs";
import { VERSION, updateStatus } from "./version.mjs";

const USER_CONTROL_REASON_DEFAULT = "manual_takeover";
const NODE_HOST = fileURLToPath(new URL("./node-host.mjs", import.meta.url));
const HELPER_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "LANG", "LANGUAGE", "TZ", "TMPDIR", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "AGENTSPACE_HOME"];

// The helper gets a fixed environment, not the caller's shell environment.
function helperEnvironment(paths) {
  const env = {};
  for (const key of HELPER_ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const [key, value] of Object.entries(process.env)) if (key.startsWith("LC_")) env[key] = value;
  env.EGO_BROWSER_STATE_DIR = join(paths.dataDir, "sdk-state");
  return env;
}

export class EgoDaemon {
  paths;
  profiles;
  #hosts = new Map();
  #spaces = new Map();
  #nextSpaceId = 1;
  #channels = new Map();
  #clients = new Set();
  #server = null;
  #panel = null;
  #panelToken = randomBytes(16).toString("hex");
  #internalWindows = new Set();
  #clipboards = new WeakMap();

  constructor(instance) {
    this.paths = servicePaths(instance);
    ensureDir(this.paths.dataDir);
    ensureDir(this.paths.profilesDir);
    ensureDir(this.paths.runtimeDir);
    this.profiles = new ProfileStore(this.paths.profilesFile);
    this.#loadSpaces();
  }

  log(...parts) {
    appendFileSync(this.paths.logFile, `${new Date().toISOString()} ${parts.join(" ")}\n`);
  }

  // ---------------------------------------------------------------- persistence

  #loadSpaces() {
    if (!existsSync(this.paths.spacesFile)) return;
    try {
      const state = JSON.parse(readFileSync(this.paths.spacesFile, "utf8"));
      this.#nextSpaceId = state.nextId || 1;
      for (const space of state.spaces || []) {
        this.#spaces.set(space.id, { ...space, windowIds: new Set(space.windowIds || []) });
      }
    } catch (error) {
      this.log("ignoring unreadable spaces file:", error.message);
    }
  }

  #saveSpaces() {
    const spaces = [...this.#spaces.values()].map((space) => ({
      ...space,
      windowIds: [...space.windowIds],
    }));
    const temp = `${this.paths.spacesFile}.tmp`;
    writeFileSync(temp, JSON.stringify({ nextId: this.#nextSpaceId, spaces }, null, 2), { mode: 0o600 });
    renameSync(temp, this.paths.spacesFile);
  }

  // ---------------------------------------------------------------- browsers

  async host(profileId) {
    let host = this.#hosts.get(profileId);
    if (!host) {
      host = new BrowserHost({
        profileId,
        profilesDir: this.paths.profilesDir,
        logFile: this.paths.logFile,
      });
      host.onExit(() => this.#onHostExit(host));
      this.#hosts.set(profileId, host);
    }
    await host.ensureStarted();
    return host;
  }

  runningHosts() {
    return [...this.#hosts.values()].filter((host) => host.running);
  }

  #onHostExit(host) {
    this.log(`browser for profile ${host.profileId} disconnected`);
    for (const [spaceId, channel] of [...this.#channels]) {
      if (channel.host !== host) continue;
      this.#channels.delete(spaceId);
      channel.close();
    }
    for (const space of this.#spaces.values()) {
      if (space.profileId === host.profileId) space.windowIds.clear();
    }
    this.#pruneSpaces();
  }

  /** Bring user spaces in line with the live windows of every running browser. */
  async #syncWindows(host) {
    const live = new Map();
    for (const page of host.pages()) {
      const windowId = await host.windowOf(page.targetId);
      if (windowId === undefined) continue;
      if (!live.has(windowId)) live.set(windowId, []);
      live.get(windowId).push(page);
    }
    const owned = new Map();
    for (const space of this.#spaces.values()) {
      if (space.profileId !== host.profileId) continue;
      for (const windowId of [...space.windowIds]) {
        if (!live.has(windowId)) space.windowIds.delete(windowId);
        else owned.set(windowId, space);
      }
    }
    for (const [windowId, pages] of live) {
      if (owned.has(windowId) || this.#internalWindows.has(windowId)) continue;
      // A window opened by an agent tab (popup) joins the opener's space.
      const opener = pages.map((page) => page.openerId).find(Boolean);
      const openerSpace = opener && (await this.#spaceOfTarget(host, opener, owned));
      if (openerSpace) {
        openerSpace.windowIds.add(windowId);
        owned.set(windowId, openerSpace);
        continue;
      }
      const id = this.#nextSpaceId++;
      const space = {
        id,
        name: `Space ${id}`,
        createdBy: "user",
        ownership: "user",
        profileId: host.profileId,
        windowIds: new Set([windowId]),
        activeTargetId: pages.at(-1)?.targetId,
        agentState: "",
      };
      this.#spaces.set(id, space);
      owned.set(windowId, space);
    }
    this.#pruneSpaces();
  }

  async #spaceOfTarget(host, targetId, owned) {
    const windowId = await host.windowOf(targetId);
    return windowId === undefined ? undefined : owned.get(windowId);
  }

  // User spaces disappear with their last window; agent spaces persist.
  #pruneSpaces() {
    for (const [id, space] of this.#spaces) {
      if (space.createdBy === "user" && space.ownership === "user" && space.windowIds.size === 0) {
        this.#spaces.delete(id);
      }
    }
    this.#saveSpaces();
  }

  async #memberOf(space, host, info) {
    if (!info) return false;
    if (info.type === "page") {
      const windowId = await host.windowOf(info.targetId);
      if (windowId !== undefined && space.windowIds.has(windowId)) return true;
      if (info.openerId) {
        const opener = host.target(info.openerId);
        if (opener && opener.targetId !== info.targetId && (await this.#memberOf(space, host, opener))) {
          if (windowId !== undefined && !this.#windowOwner(host, windowId)) space.windowIds.add(windowId);
          return true;
        }
      }
      return false;
    }
    if (info.type === "iframe") {
      const windowId = await host.windowOf(info.targetId);
      return windowId !== undefined && space.windowIds.has(windowId);
    }
    return false;
  }

  #windowOwner(host, windowId) {
    for (const space of this.#spaces.values()) {
      if (space.profileId === host.profileId && space.windowIds.has(windowId)) return space;
    }
    return undefined;
  }

  async #memberPages(space, host) {
    const pages = [];
    for (const page of host.pages()) {
      if (await this.#memberOf(space, host, page)) pages.push(page);
    }
    return pages;
  }

  // ---------------------------------------------------------------- spaces

  #space(spaceId) {
    if (spaceId === undefined || spaceId === null) {
      throw new EgoError("Task space not selected", CODES.TASK_SPACE_NOT_SELECTED);
    }
    const space = this.#spaces.get(spaceId);
    if (!space) throw new EgoError(`Task space not found: ${spaceId}`, CODES.TASK_SPACE_NOT_FOUND);
    return space;
  }

  /** Task-scoped automation requires an Agent-owned space under Agent control. */
  #agentSpace(spaceId) {
    const space = this.#space(spaceId);
    if (space.ownership === "agentDelegatedToUser") {
      throw new EgoError(space.controlReason || USER_CONTROL_REASON_DEFAULT, CODES.TASK_SPACE_USER_IN_CONTROL);
    }
    if (space.ownership !== "agent") {
      throw new EgoError(
        `The task space ${spaceId} belongs to the user. Claim it before automating it.`,
        CODES.TASK_SPACE_USER_IN_CONTROL,
      );
    }
    return space;
  }

  descriptor(space, extra = {}) {
    const profile = this.profiles.get(space.profileId);
    return {
      taskId: space.name,
      id: space.id,
      name: space.name,
      createdBy: space.createdBy,
      ownership: space.ownership,
      profileId: space.profileId,
      profileName: profile?.name,
      ...extra,
    };
  }

  async listTaskSpaces() {
    for (const host of this.runningHosts()) await this.#syncWindows(host);
    const taskSpaces = [];
    for (const space of this.#spaces.values()) {
      const host = this.#hosts.get(space.profileId);
      const pages = host?.running ? await this.#memberPages(space, host) : [];
      taskSpaces.push(
        this.descriptor(space, {
          recentTabTitles: pages.slice(-5).map((page) => page.title || page.url),
          ...(space.agentState ? { agentState: space.agentState } : {}),
        }),
      );
    }
    return { taskSpaces };
  }

  async createTaskSpace(name, profileId) {
    if (typeof name !== "string" || name.length === 0) {
      throw new EgoError("createTaskSpace(name, profileId?) requires a non-empty name", CODES.INVALID_ARGUMENT);
    }
    const profile = this.profiles.resolve(profileId);
    if (!profile) throw new EgoError("Profile not found", CODES.PROFILE_NOT_FOUND);
    const host = await this.host(profile.id).catch((error) => {
      throw new EgoError(`No active browser: ${error.message}`, CODES.BROWSER_UNAVAILABLE);
    });
    await this.#syncWindows(host);
    for (const space of this.#spaces.values()) {
      if (space.name === name) {
        throw new EgoError(`Task space already exists: ${name}`, CODES.TASK_SPACE_NAME_IN_USE);
      }
    }
    const id = this.#nextSpaceId++;
    const space = {
      id,
      name,
      createdBy: "agent",
      ownership: "agent",
      profileId: profile.id,
      windowIds: new Set(),
      activeTargetId: undefined,
      agentState: "",
    };
    this.#spaces.set(id, space);
    try {
      await this.#openWindow(space, host, "about:blank");
    } catch (error) {
      this.#spaces.delete(id);
      throw new EgoError(`Failed to create task space window: ${error.message}`, CODES.BROWSER_UNAVAILABLE);
    }
    this.#saveSpaces();
    return this.descriptor(space);
  }

  async claimTaskSpace(id, name) {
    const space = this.#spaces.get(id);
    if (!space || space.ownership !== "user") {
      throw new EgoError(`Task space not found: ${id}`, CODES.TASK_SPACE_NOT_FOUND);
    }
    if (name !== undefined) space.name = name;
    space.ownership = "agent";
    space.createdBy = "agent";
    space.controlReason = undefined;
    this.#saveSpaces();
    return this.descriptor(space);
  }

  async closeTaskSpace(spaceId) {
    const space = this.#agentSpace(spaceId);
    const host = this.#hosts.get(space.profileId);
    if (host?.running) {
      for (const page of await this.#memberPages(space, host)) {
        await host.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
      }
    }
    this.#channels.get(space.id)?.close();
    this.#channels.delete(space.id);
    this.#spaces.delete(space.id);
    this.#saveSpaces();
    return `${space.id} task space closed.`;
  }

  async completeTaskSpace(spaceId) {
    const space = this.#agentSpace(spaceId);
    space.ownership = "user";
    space.agentState = "";
    this.#channels.get(space.id)?.close();
    this.#channels.delete(space.id);
    this.#saveSpaces();
    return `${space.id} task space completed.`;
  }

  async handOffTaskSpace(spaceId, reason = USER_CONTROL_REASON_DEFAULT) {
    const space = this.#agentSpace(spaceId);
    space.ownership = "agentDelegatedToUser";
    space.controlReason = reason;
    this.#saveSpaces();
    const host = this.#hosts.get(space.profileId);
    if (host?.running && !host.headless && space.activeTargetId) {
      await host.send("Target.activateTarget", { targetId: space.activeTargetId }).catch(() => {});
    }
    return `${space.id} has been handed off to the user.`;
  }

  async takeOverTaskSpace(spaceId) {
    const space = this.#space(spaceId);
    if (space.ownership === "user") {
      throw new EgoError(
        `The task space ${spaceId} belongs to the user. Claim it before automating it.`,
        CODES.TASK_SPACE_USER_IN_CONTROL,
      );
    }
    space.ownership = "agent";
    space.controlReason = undefined;
    this.#saveSpaces();
    return `${space.id} has been taken over by the agent.`;
  }

  async setAgentTaskState(spaceId, state) {
    const space = this.#agentSpace(spaceId);
    space.agentState = state;
    return `${space.id} state updated.`;
  }

  async #agentHost(space) {
    try {
      return await this.host(space.profileId);
    } catch (error) {
      throw new EgoError(`No active browser: ${error.message}`, CODES.BROWSER_UNAVAILABLE);
    }
  }

  async #openWindow(space, host, url) {
    const { targetId } = await host.send("Target.createTarget", {
      url,
      newWindow: true,
      background: true,
    });
    const windowId = await host.windowOf(targetId, { fresh: true });
    if (windowId !== undefined) space.windowIds.add(windowId);
    space.activeTargetId = targetId;
    return targetId;
  }

  // Open a tab inside the space's window: window.open from a member tab keeps
  // the new tab in that window; without a usable tab, open a new window.
  async #openTab(space, host, url) {
    const pages = await this.#memberPages(space, host);
    const source = pages.find((page) => page.targetId === space.activeTargetId) || pages.at(-1);
    if (source && !this.#channels.get(space.id)?.openDialog(source.targetId)) {
      const sourceWindow = await host.windowOf(source.targetId, { fresh: true });
      const known = new Set(host.pages().map((page) => page.targetId));
      const created = new Promise((resolve) => {
        const stop = host.onTargetEvent((message) => {
          const info = message.params?.targetInfo;
          if (message.method === "Target.targetCreated" && info?.type === "page" && !known.has(info.targetId)) {
            stop();
            resolve(info.targetId);
          }
        });
        setTimeout(() => {
          stop();
          resolve(undefined);
        }, 3_000);
      });
      try {
        const sessionId = await host.pageSession(source.targetId);
        await host.send(
          "Runtime.evaluate",
          {
            expression: `void window.open(${JSON.stringify(url)}, "_blank", "noopener")`,
            userGesture: true,
          },
          sessionId,
          { timeoutMs: 2_000 },
        );
        const targetId = await created;
        if (targetId && (await host.windowOf(targetId, { fresh: true })) === sourceWindow) {
          space.activeTargetId = targetId;
          return targetId;
        }
        if (targetId) await host.send("Target.closeTarget", { targetId }).catch(() => {});
      } catch (error) {
        this.log(`window.open in space ${space.id} failed: ${error.message}`);
      }
    }
    return this.#openWindow(space, host, url);
  }

  async createTab(spaceId, url) {
    if (typeof url !== "string") throw new EgoError("createTab(url) requires a string url", CODES.INVALID_ARGUMENT);
    const space = this.#agentSpace(spaceId);
    const host = await this.#agentHost(space);
    const targetId = await this.#openTab(space, host, url);
    this.#saveSpaces();
    const info = host.target(targetId) || {};
    return { targetId, url: info.url || url, title: info.title || "" };
  }

  async listTabs(spaceId) {
    const space = this.#agentSpace(spaceId);
    const host = await this.#agentHost(space);
    const pages = await this.#memberPages(space, host);
    const active = pages.some((page) => page.targetId === space.activeTargetId)
      ? space.activeTargetId
      : pages.at(-1)?.targetId;
    return {
      tabs: pages.map((page, index) => ({
        index,
        targetId: page.targetId,
        url: page.url,
        title: page.title,
        active: page.targetId === active,
      })),
    };
  }

  async snapshot(spaceId, options) {
    const space = this.#agentSpace(spaceId);
    const host = await this.#agentHost(space);
    const { tabs } = await this.listTabs(spaceId);
    const tab = tabs.find((item) => item.active);
    if (!tab) throw new EgoError("The task space has no tab to snapshot", CODES.WEB_CONTENTS_UNAVAILABLE);
    try {
      return await captureSnapshot(await host.snapshotPage(tab.targetId), options);
    } catch (error) {
      if (error instanceof EgoError) throw error;
      throw new EgoError(`Snapshot failed: ${error.message}`, CODES.SNAPSHOT_FAILED);
    }
  }

  async animationHighlightMouseToPosition(spaceId, x, y) {
    const space = this.#agentSpace(spaceId);
    const host = await this.#agentHost(space);
    if (!host.headless && process.env.AGENTSPACE_AGENT_CURSOR !== "0" && space.activeTargetId) {
      await this.#drawCursor(host, space.activeTargetId, x, y).catch(() => {});
    }
    return `${space.id} mouse highlight shown.`;
  }

  // The cursor lives in an isolated world, is aria-hidden (outside snapshots)
  // and ignores pointer events, so it never becomes a hit-test target.
  async #drawCursor(host, targetId, x, y) {
    const sessionId = await host.pageSession(targetId);
    const { executionContextId } = await host.send(
      "Page.createIsolatedWorld",
      { frameId: targetId, worldName: "agentspace-cursor" },
      sessionId,
      { timeoutMs: 1_000 },
    );
    await host.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: `(() => {
          const id = "__agentspace_cursor__";
          let dot = document.getElementById(id);
          if (!dot) {
            dot = document.createElement("div");
            dot.id = id;
            dot.setAttribute("aria-hidden", "true");
            dot.style.cssText = "position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;" +
              "background:rgba(255,92,0,.55);box-shadow:0 0 0 3px rgba(255,92,0,.25);pointer-events:none;" +
              "z-index:2147483647;transition:left .18s ease-out,top .18s ease-out,opacity .3s";
            (document.body || document.documentElement).appendChild(dot);
          }
          dot.style.left = ${Number(x)} + "px";
          dot.style.top = ${Number(y)} + "px";
          dot.style.opacity = "1";
          clearTimeout(dot.__egoTimer);
          dot.__egoTimer = setTimeout(() => dot.remove(), 900);
        })()`,
      },
      sessionId,
      { timeoutMs: 1_000 },
    );
  }

  #clipboard(host) {
    let clipboard = this.#clipboards.get(host);
    if (!clipboard) {
      clipboard = new BrowserClipboard(host, `${this.panelOrigin()}/clipboard-helper`);
      this.#clipboards.set(host, clipboard);
    }
    return clipboard;
  }

  async beginClipboardTransaction(spaceId, content) {
    const space = this.#agentSpace(spaceId);
    const host = await this.#agentHost(space);
    return this.#clipboard(host).begin(content);
  }

  async finishClipboardTransaction(spaceId, transactionId) {
    const space = this.#space(spaceId);
    const host = await this.#agentHost(space);
    return this.#clipboard(host).finish(transactionId);
  }

  async listProfiles() {
    return { profiles: this.profiles.list() };
  }

  async getBrowserVersion() {
    return { currentVersion: VERSION, updateAvailable: await updateStatus() };
  }

  // ---------------------------------------------------------------- CDP channel

  async channel(spaceId) {
    const space = this.#agentSpace(spaceId);
    let channel = this.#channels.get(space.id);
    if (channel) return channel;
    const host = await this.#agentHost(space);
    channel = new SpaceChannel({
      host,
      spaceId: space.id,
      isMember: (info) => this.#memberOf(space, host, info),
      onActivate: (targetId) => {
        space.activeTargetId = targetId;
      },
      createTab: (url) => this.createTab(space.id, url),
      onClose: () => {
        if (this.#channels.get(space.id) === channel) this.#channels.delete(space.id);
      },
    });
    this.#channels.set(space.id, channel);
    return channel;
  }

  // ---------------------------------------------------------------- RPC

  async listen() {
    if (existsSync(this.paths.socketPath)) {
      if (await socketAlive(this.paths.socketPath)) {
        throw new Error(`agentspace daemon already running at ${this.paths.socketPath}`);
      }
      rmSync(this.paths.socketPath, { force: true });
    }
    this.#server = createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.paths.socketPath, resolve);
    });
    chmodSync(this.paths.socketPath, 0o600);
    await this.#startPanel();
    this.log(`listening on ${this.paths.socketPath} (agentspace ${VERSION})`);
  }

  #accept(socket) {
    const wire = new LineSocket(socket);
    const client = {
      wire,
      channels: new Set(),
      sendCdp: (message) => wire.send({ op: "cdp", message }),
      sendCdpError: (message, error_code) => wire.send({ op: "cdpError", message, error_code }),
    };
    this.#clients.add(client);
    wire.onMessage((message) => this.#onClientMessage(client, message));
    wire.onClose(() => {
      this.#clients.delete(client);
      if (client.child) {
        const child = client.child;
        child.kill("SIGTERM");
        setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2_000).unref();
      }
      for (const channel of client.channels) channel.dropClient(client);
    });
  }

  // Run `agentspace run` in a Node helper that is a child of this daemon,
  // streaming its stdio back to the CLI that asked for it.
  #runHost(client, message) {
    if (client.child) return;
    const mode = message.mode === "repl" ? "repl" : "script";
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", NODE_HOST, mode, this.paths.instance, message.sdkPath], {
      cwd: homedir(),
      env: helperEnvironment(this.paths),
      stdio: ["pipe", "pipe", "pipe"],
    });
    client.child = child;
    const forward = (op) => (chunk) => client.wire.send({ op, data: chunk.toString("base64") });
    child.stdout.on("data", forward("stdout"));
    child.stderr.on("data", forward("stderr"));
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => {
      client.child = null;
      client.wire.send({ op: "exit", code: code ?? (signal ? 128 + (osConstants.signals[signal] || 1) : 1) });
    });
    child.on("error", (error) => {
      client.wire.send({ op: "stderr", data: Buffer.from(`${error.message}\n`).toString("base64") });
    });
    if (mode === "script") child.stdin.end(message.code ?? "");
  }

  async #onClientMessage(client, message) {
    if (message.op === "run") {
      this.#runHost(client, message);
      return;
    }
    if (message.op === "stdin") {
      if (!client.child) return;
      if (message.data) client.child.stdin.write(Buffer.from(message.data, "base64"));
      if (message.end) client.child.stdin.end();
      return;
    }
    if (message.op === "cdp") {
      try {
        const channel = await this.channel(message.spaceId);
        client.channels.add(channel);
        await channel.fromClient(client, message.message);
      } catch (error) {
        const result = toErrorResult(error);
        client.sendCdpError(result.error, result.error_code === CODES.OPERATION_FAILED ? CODES.CDP_SEND_FAILED : result.error_code);
      }
      return;
    }
    if (message.op !== "call") return;
    let response;
    try {
      response = { id: message.id, result: await this.#dispatch(message.method, message.spaceId, message.args || []) };
    } catch (error) {
      response = { id: message.id, error: toErrorResult(error) };
    }
    client.wire.send(response);
  }

  async #dispatch(method, spaceId, args) {
    switch (method) {
      case "getBrowserVersion":
        return this.getBrowserVersion();
      case "listProfiles":
        return this.listProfiles();
      case "listTaskSpaces":
        return this.listTaskSpaces();
      case "createTaskSpace":
        return this.createTaskSpace(args[0], args[1]);
      case "claimTaskSpace":
        return this.claimTaskSpace(args[0], args[1]);
      case "closeTaskSpace":
        return this.closeTaskSpace(spaceId);
      case "completeTaskSpace":
        return this.completeTaskSpace(spaceId);
      case "handOffTaskSpace":
        return this.handOffTaskSpace(spaceId);
      case "takeOverTaskSpace":
        return this.takeOverTaskSpace(spaceId);
      case "setAgentTaskState":
        return this.setAgentTaskState(spaceId, args[0]);
      case "createTab":
        return this.createTab(spaceId, args[0]);
      case "listTabs":
        return this.listTabs(spaceId);
      case "snapshot":
        return this.snapshot(spaceId, args[0]);
      case "animationHighlightMouseToPosition":
        return this.animationHighlightMouseToPosition(spaceId, args[0], args[1]);
      case "beginClipboardTransaction":
        return this.beginClipboardTransaction(spaceId, args[0]);
      case "finishClipboardTransaction":
        return this.finishClipboardTransaction(spaceId, args[0]);
      case "status":
        return this.status();
      case "openPanel":
        return this.openPanel();
      case "reloadProfiles":
        return this.reloadProfiles();
      case "start":
        await this.host(this.profiles.defaultId);
        return this.status();
      case "openUrl":
        return this.openUrl(args[0]);
      case "stopBrowsers":
        for (const host of this.runningHosts()) await host.stop();
        return "browsers stopped";
      case "shutdown":
        setTimeout(() => this.shutdown(), 10);
        return "shutting down";
      default:
        throw new EgoError(`Unknown method: ${method}`, CODES.INVALID_ARGUMENT);
    }
  }

  async reloadProfiles() {
    this.profiles = new ProfileStore(this.paths.profilesFile);
    const known = new Set(this.profiles.list().map((profile) => profile.id));
    for (const [profileId, host] of [...this.#hosts]) {
      if (known.has(profileId)) continue;
      await host.stop();
      this.#hosts.delete(profileId);
    }
    for (const [id, space] of [...this.#spaces]) {
      if (!known.has(space.profileId)) this.#spaces.delete(id);
    }
    this.#saveSpaces();
    return { profiles: this.profiles.list() };
  }

  /** Open a URL for the user: a new window becomes a user-owned Space. */
  async openUrl(url) {
    if (typeof url !== "string" || !url) throw new EgoError("open requires a URL", CODES.INVALID_ARGUMENT);
    const host = await this.host(this.profiles.defaultId);
    const { targetId } = await host.send("Target.createTarget", { url, newWindow: true });
    await this.#syncWindows(host);
    return `Opened ${url} (${targetId})`;
  }

  async status() {
    const spaces = await this.listTaskSpaces();
    return {
      version: VERSION,
      instance: this.paths.instance,
      socket: this.paths.socketPath,
      panel: this.#panel ? this.panelUrl() : null,
      browsers: this.runningHosts().map((host) => ({
        profileId: host.profileId,
        headless: host.headless,
        wsUrl: host.wsUrl,
      })),
      ...spaces,
    };
  }

  async shutdown() {
    for (const host of this.runningHosts()) await host.stop();
    this.#server?.close();
    this.#panel?.close();
    rmSync(this.paths.socketPath, { force: true });
    rmSync(this.paths.panelFile, { force: true });
    process.exit(0);
  }

  // ---------------------------------------------------------------- control panel

  panelOrigin() {
    return `http://127.0.0.1:${this.#panel.address().port}`;
  }

  panelUrl() {
    return `${this.panelOrigin()}/?token=${this.#panelToken}`;
  }

  async #startPanel() {
    this.#panel = createHttpServer((request, response) => this.#onPanelRequest(request, response));
    await new Promise((resolve) => this.#panel.listen(0, "127.0.0.1", resolve));
    writeFileSync(this.paths.panelFile, JSON.stringify({ url: this.panelUrl() }), { mode: 0o600 });
  }

  async openPanel() {
    const host = await this.host(this.profiles.defaultId);
    if (host.headless) return { url: this.panelUrl(), opened: false };
    const { targetId } = await host.send("Target.createTarget", { url: this.panelUrl(), newWindow: true });
    const windowId = await host.windowOf(targetId, { fresh: true });
    if (windowId !== undefined) this.#internalWindows.add(windowId);
    return { url: this.panelUrl(), opened: true };
  }

  async #onPanelRequest(request, response) {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/clipboard-helper") {
      // Blank secure-context document for BrowserClipboard; it exposes nothing.
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>agentspace clipboard</title>");
      return;
    }
    if (url.searchParams.get("token") !== this.#panelToken) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderPanel());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/spaces") {
        const { taskSpaces } = await this.listTaskSpaces();
        const spaces = taskSpaces.map((space) => ({
          ...space,
          agentState: this.#spaces.get(space.id)?.agentState || "",
          controlReason: this.#spaces.get(space.id)?.controlReason,
        }));
        json(response, 200, { version: VERSION, spaces, profiles: this.profiles.list() });
        return;
      }
      const action = /^\/api\/spaces\/(\d+)\/(take-control|return-control|close)$/.exec(url.pathname);
      if (request.method === "POST" && action) {
        const id = Number(action[1]);
        const space = this.#space(id);
        let result;
        if (action[2] === "take-control") {
          if (space.ownership !== "agent") throw new EgoError("Only an Agent-controlled space can be taken over");
          result = await this.handOffTaskSpace(id, "manual_takeover");
        } else if (action[2] === "return-control") {
          result = await this.takeOverTaskSpace(id);
        } else {
          if (space.ownership !== "agent") space.ownership = "agent";
          result = await this.closeTaskSpace(id);
        }
        json(response, 200, { result });
        return;
      }
      response.writeHead(404).end("not found");
    } catch (error) {
      json(response, 400, toErrorResult(error));
    }
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export function socketAlive(path) {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

export async function runDaemon(instance) {
  const daemon = new EgoDaemon(instance);
  process.on("uncaughtException", (error) => daemon.log("uncaught:", error?.stack || error));
  process.on("unhandledRejection", (error) => daemon.log("unhandled:", error?.stack || error));
  process.on("SIGTERM", () => daemon.shutdown());
  await daemon.listen();
  return daemon;
}
