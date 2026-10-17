// Accessibility-tree snapshot in the text format the ego-browser SDK parses:
//
//   root
//     heading "Title" level=1
//     button "Save" [ref=12, loc=role:button[name="Save"]]
//     iframe [ref=20]
//       root
//         link "Docs" [ref=7, url=https://example.com/docs]
//
// It is assembled from Accessibility.getFullAXTree (roles, names, states), DOMSnapshot.captureSnapshot
// (layout bounds, attributes, click listeners) and the frame tree, per renderer
// session, so OOPIF content is included with frame provenance.

import { CODES, EgoError } from "./errors.mjs";

const SCOPES = new Set(["full_page", "only_within_viewport", "subtree"]);

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
  "textfield",
  "iframe",
  "video",
  "audio",
]);

// Roles whose accessible name is computed from their text content. Their text
// children repeat the name and are omitted.
const NAME_FROM_CONTENT = new Set([
  "button",
  "link",
  "heading",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "treeitem",
  "switch",
  "checkbox",
  "radio",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "label_text",
  "legend",
  "caption",
  "figcaption",
]);

const SKIPPED_ROLES = new Set(["inline_text_box", "line_break", "list_marker"]);
const CONTAINER_ROLES = new Set(["generic", "none", "presentation", "section", "group_container", "div"]);
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "textfield"]);
const STATE_PROPERTIES = ["checked", "pressed", "expanded", "selected", "disabled", "required", "readonly"];
const GENERATED_ID = /^(react-|radix-|headlessui-|ember|:r)|\d{4,}|^[0-9a-f]{8,}$/i;

export function normalizeSnapshotOptions(options) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new EgoError(
      "ego.snapshot(options?) expects an options object with scope 'only_within_viewport', 'full_page', or 'subtree'.",
      CODES.INVALID_ARGUMENT,
    );
  }
  const scope = options.scope ?? "full_page";
  if (!SCOPES.has(scope)) {
    throw new EgoError(
      "ego.snapshot(options?) expects an options object with scope 'only_within_viewport', 'full_page', or 'subtree'.",
      CODES.INVALID_ARGUMENT,
    );
  }
  if (scope === "subtree" && !Number.isInteger(options.root)) {
    throw new EgoError(
      "ego.snapshot({ scope: 'subtree' }) requires root to be a backendNodeId number.",
      CODES.INVALID_ARGUMENT,
    );
  }
  const maxResultLength = options.maxResultLength ?? 0;
  if (!Number.isFinite(maxResultLength) || maxResultLength < 0) {
    throw new EgoError("maxResultLength must be a non-negative number.", CODES.INVALID_ARGUMENT);
  }
  return {
    scope,
    root: options.root,
    includeActionMarks: options.includeActionMarks !== false,
    interactiveOnly: options.interactiveOnly === true,
    includeStableLocator: options.includeStableLocator === true,
    maxResultLength: Math.floor(maxResultLength),
  };
}

export function roleName(raw) {
  const value = String(raw || "");
  if (value === "RootWebArea" || value === "WebArea") return "root";
  if (value === "StaticText") return "text";
  if (value === "Iframe" || value === "IframePresentational") return "iframe";
  const snake = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  if (CONTAINER_ROLES.has(snake)) return "container";
  return snake;
}

/** Capture one snapshot of a Page whose sessions are owned by the caller. */
export async function captureSnapshot(page, rawOptions) {
  const options = normalizeSnapshotOptions(rawOptions);
  const contexts = await collectFrameContexts(page);
  const main = contexts.find((context) => context.isMain);
  if (!main) throw new EgoError("Page has no main frame", CODES.WEB_CONTENTS_UNAVAILABLE);

  const viewport =
    options.scope === "only_within_viewport" ? await readViewport(page, main.sessionId) : null;

  // Group frames by their renderer session so each session is snapshotted once.
  const layoutBySession = new Map();
  for (const sessionId of new Set(contexts.map((context) => context.sessionId))) {
    layoutBySession.set(sessionId, await captureLayout(page, sessionId));
  }

  for (const context of contexts) {
    const layout = layoutBySession.get(context.sessionId);
    context.dom = layout.byFrame.get(context.frameId) || emptyDocument();
    const response = await page.send(
      "Accessibility.getFullAXTree",
      { frameId: context.frameId },
      context.sessionId,
    );
    context.ax = indexAxTree(response.nodes || []);
  }

  // Map each child frame to its owner iframe element in the parent frame.
  const byFrame = new Map(contexts.map((context) => [context.frameId, context]));
  for (const context of contexts) {
    if (context.isMain) continue;
    const parent = context.parentFrameId && byFrame.get(context.parentFrameId);
    if (parent) {
      try {
        const owner = await page.send("DOM.getFrameOwner", { frameId: context.frameId }, parent.sessionId);
        if (Number.isInteger(owner.backendNodeId)) parent.childFramesByOwner.set(owner.backendNodeId, context);
      } catch {}
      continue;
    }
    // OOPIF root: ask every other renderer which element owns it.
    for (const sessionId of new Set(contexts.map((item) => item.sessionId))) {
      if (sessionId === context.sessionId) continue;
      let owner;
      try {
        owner = await page.send("DOM.getFrameOwner", { frameId: context.frameId }, sessionId);
      } catch {
        continue;
      }
      const host = contexts.find(
        (item) => item.sessionId === sessionId && item.dom.nodes.has(owner.backendNodeId),
      );
      if (host) {
        context.parentFrameId = host.frameId;
        host.childFramesByOwner.set(owner.backendNodeId, context);
        break;
      }
    }
  }

  computeFrameGeometry(main, viewport);

  const builder = new SnapshotBuilder(options, main);
  let lines;
  if (options.scope === "subtree") {
    const matches = [];
    for (const context of contexts) {
      const node = context.ax.byBackend.get(options.root);
      if (node) matches.push({ context, node });
    }
    if (matches.length === 0) {
      throw new EgoError(`Snapshot root not found: ${options.root}`, CODES.SNAPSHOT_FAILED);
    }
    if (matches.length > 1) {
      throw new EgoError(
        `Snapshot root ${options.root} is ambiguous across ${matches.length} frames; take a new snapshot`,
        CODES.SNAPSHOT_FAILED,
      );
    }
    lines = builder.renderFrom(matches[0].context, matches[0].node);
  } else {
    lines = builder.renderFrame(main, 0);
  }
  return builder.finish(lines);
}

function emptyDocument() {
  return { nodes: new Map(), ids: new Map(), attributeCounts: new Map(), baseURL: "", scrollX: 0, scrollY: 0 };
}

async function collectFrameContexts(page) {
  const contexts = [];
  const tree = (await page.send("Page.getFrameTree", {}, page.sessionId)).frameTree;
  const oopifSessions = page.childSessions || new Map();
  const visit = (node, parentFrameId, sessionId, isMain) => {
    const frameId = node.frame.id;
    const childSession = !isMain && oopifSessions.get(frameId);
    const owner = childSession || sessionId;
    contexts.push({
      frameId,
      parentFrameId,
      sessionId: owner,
      isMain,
      url: node.frame.url,
      childFramesByOwner: new Map(),
    });
    for (const child of node.childFrames || []) visit(child, frameId, owner, false);
  };
  visit(tree, undefined, page.sessionId, true);
  // The main session's frame tree stops at out-of-process iframes. Each OOPIF
  // session reports its own subtree; its owner element is found later.
  const known = new Set(contexts.map((context) => context.frameId));
  for (const [frameId, sessionId] of oopifSessions) {
    if (known.has(frameId)) continue;
    let childTree;
    try {
      childTree = (await page.send("Page.getFrameTree", {}, sessionId)).frameTree;
    } catch {
      continue;
    }
    const stack = [[childTree, undefined]];
    while (stack.length) {
      const [node, parent] = stack.pop();
      if (known.has(node.frame.id)) continue;
      known.add(node.frame.id);
      contexts.push({
        frameId: node.frame.id,
        parentFrameId: parent,
        sessionId,
        isMain: false,
        url: node.frame.url,
        childFramesByOwner: new Map(),
      });
      for (const child of node.childFrames || []) stack.push([child, node.frame.id]);
    }
  }
  return contexts;
}

async function readViewport(page, sessionId) {
  const metrics = await page.send("Page.getLayoutMetrics", {}, sessionId);
  const visual = metrics.cssVisualViewport || metrics.visualViewport || {};
  return {
    x: 0,
    y: 0,
    width: visual.clientWidth || 0,
    height: visual.clientHeight || 0,
  };
}

async function captureLayout(page, sessionId) {
  const response = await page.send(
    "DOMSnapshot.captureSnapshot",
    { computedStyles: ["visibility"], includeDOMRects: true },
    sessionId,
  );
  const strings = response.strings || [];
  const str = (index) => (index >= 0 ? strings[index] : undefined);
  const byFrame = new Map();
  for (const document of response.documents || []) {
    const frameId = str(document.frameId);
    const nodes = new Map();
    const ids = new Map();
    const attributeCounts = new Map();
    const tree = document.nodes || {};
    const backendIds = tree.backendNodeId || [];
    const names = tree.nodeName || [];
    const attributes = tree.attributes || [];
    const clickable = new Set(tree.isClickable?.index || []);
    const boundsByIndex = new Map();
    const layout = document.layout || {};
    (layout.nodeIndex || []).forEach((nodeIndex, position) => {
      const rect = layout.bounds?.[position];
      const visibility = str(layout.styles?.[position]?.[0]);
      const previous = boundsByIndex.get(nodeIndex);
      if (!rect) return;
      // Text nodes can own several layout fragments; keep their union.
      boundsByIndex.set(nodeIndex, {
        rect: previous ? unionRect(previous.rect, rect) : rect,
        hidden: visibility === "hidden" || visibility === "collapse",
      });
    });
    for (let index = 0; index < backendIds.length; index += 1) {
      const attrs = {};
      const list = attributes[index] || [];
      for (let cursor = 0; cursor + 1 < list.length; cursor += 2) {
        attrs[str(list[cursor])] = str(list[cursor + 1]);
      }
      const nodeName = String(str(names[index]) || "").toLowerCase();
      const info = {
        nodeName,
        attrs,
        clickable: clickable.has(index),
        layout: boundsByIndex.get(index),
      };
      nodes.set(backendIds[index], info);
      if (attrs.id) ids.set(attrs.id, (ids.get(attrs.id) || 0) + 1);
      for (const key of ["placeholder", "aria-label", "href"]) {
        if (attrs[key] !== undefined) {
          const countKey = `${key}\u0000${nodeName}\u0000${attrs[key]}`;
          attributeCounts.set(countKey, (attributeCounts.get(countKey) || 0) + 1);
          const anyKey = `${key}\u0000*\u0000${attrs[key]}`;
          attributeCounts.set(anyKey, (attributeCounts.get(anyKey) || 0) + 1);
        }
      }
    }
    byFrame.set(frameId, {
      nodes,
      ids,
      attributeCounts,
      baseURL: str(document.baseURL) || str(document.documentURL) || "",
      scrollX: document.scrollOffsetX || 0,
      scrollY: document.scrollOffsetY || 0,
    });
  }
  return { byFrame };
}

function unionRect(a, b) {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const right = Math.max(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x, y, right - x, bottom - y];
}

function indexAxTree(nodes) {
  const byId = new Map();
  const byBackend = new Map();
  const roleNameCounts = new Map();
  let root;
  for (const node of nodes) {
    byId.set(node.nodeId, node);
    if (Number.isInteger(node.backendDOMNodeId) && !node.ignored) {
      // The first non-ignored AX node for a DOM node is its primary object.
      if (!byBackend.has(node.backendDOMNodeId)) byBackend.set(node.backendDOMNodeId, node);
    }
    if (!node.parentId && !root) root = node;
    if (!node.ignored) {
      const key = `${roleName(node.role?.value)}\u0000${axName(node)}`;
      roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
    }
  }
  return { byId, byBackend, roleNameCounts, root };
}

function axName(node) {
  const value = node?.name?.value;
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function axProperty(node, name) {
  for (const property of node.properties || []) {
    if (property.name === name) return property.value?.value;
  }
  return undefined;
}

// Translate every frame document into main-viewport coordinates and clip.
function computeFrameGeometry(main, viewport) {
  const visit = (context, offsetX, offsetY, clip) => {
    context.offsetX = offsetX;
    context.offsetY = offsetY;
    context.clip = clip;
    for (const [ownerId, child] of context.childFramesByOwner) {
      const owner = context.dom.nodes.get(ownerId)?.layout?.rect;
      if (!owner) {
        visit(child, offsetX, offsetY, clip && { x: 0, y: 0, width: 0, height: 0 });
        continue;
      }
      const left = owner[0] + offsetX;
      const top = owner[1] + offsetY;
      const childClip = clip
        ? intersect(clip, { x: left, y: top, width: owner[2], height: owner[3] })
        : null;
      visit(child, left - child.dom.scrollX, top - child.dom.scrollY, childClip);
    }
  };
  visit(main, -main.dom.scrollX, -main.dom.scrollY, viewport);
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

class SnapshotBuilder {
  #options;
  #main;
  #refs = [];
  #usedRefIds = new Set();
  #nextSyntheticRef = 1_000_000;

  constructor(options, main) {
    this.#options = options;
    this.#main = main;
  }

  renderFrame(context, depth) {
    const root = context.ax.root;
    if (!root) return [`${"  ".repeat(depth)}root`];
    const nodes = this.#renderNode(context, root, null, true);
    return nodes.flatMap((node) => flatten(node, depth));
  }

  renderFrom(context, node) {
    const nodes = this.#renderNode(context, node, null, true);
    return nodes.flatMap((item) => flatten(item, 0));
  }

  finish(lines) {
    let content = lines.join("\n");
    let refs = this.#refs;
    const limit = this.#options.maxResultLength;
    if (limit > 0 && content.length > limit) {
      const cut = content.lastIndexOf("\n", limit);
      content = content.slice(0, cut > 0 ? cut : limit);
      const shown = new Set();
      for (const match of content.matchAll(/\[ref=(\d+)/g)) shown.add(Number(match[1]));
      refs = refs.filter((ref) => shown.has(ref.refId));
    }
    return { content, refs };
  }

  // Returns tree items { text, children } for one AX node. Ignored and
  // filtered nodes hoist their children so the hierarchy stays compact.
  #renderNode(context, node, nameContext, isRoot) {
    const role = roleName(node.role?.value);
    if (SKIPPED_ROLES.has(role)) return [];
    const children = [];
    const childNameContext = node.ignored ? nameContext : nextNameContext(role, axName(node), nameContext);
    for (const childId of node.childIds || []) {
      const child = context.ax.byId.get(childId);
      if (child) children.push(...this.#renderNode(context, child, childNameContext, false));
    }
    if (role === "iframe" || context.childFramesByOwner.has(node.backendDOMNodeId)) {
      const frame = context.childFramesByOwner.get(node.backendDOMNodeId);
      if (frame) {
        const frameItems = this.#renderNode(frame, frame.ax.root || { childIds: [] }, null, true);
        children.push(...frameItems);
      }
    }
    if (node.ignored && !isRoot) return children;

    if (this.#options.scope === "only_within_viewport") {
      if (role === "root") {
        if (context.clip && (context.clip.width <= 0 || context.clip.height <= 0)) return [];
      } else if (!this.#isVisible(context, node)) {
        // Offscreen nodes disappear; visible descendants (overflow) remain.
        return children;
      }
    }

    const name = axName(node);
    if (role === "text") {
      if (!name || isBlank(name)) return [];
      if (nameContext && nameContext.includes(name)) return [];
      if (this.#options.interactiveOnly) return [];
      return [{ text: `text ${JSON.stringify(name)}`, children: [] }];
    }

    const dom = context.dom.nodes.get(node.backendDOMNodeId);
    const actionable = this.#isActionable(role, node, dom);
    if (this.#options.interactiveOnly && !actionable && role !== "root" && role !== "iframe") {
      return children;
    }
    if (role === "container" && !name && !actionable) {
      if (children.length === 0) return [];
      if (children.length === 1) return children;
    }

    // The native tree encoding requires a bare `root` line per document.
    if (role === "root") return [{ text: "root", children }];

    let text = role;
    if (name) text += ` ${JSON.stringify(name)}`;
    text += describeStates(role, node);
    if (actionable && node.backendDOMNodeId !== undefined) {
      const ref = this.#addRef(context, role, name, node, dom);
      if (this.#options.includeActionMarks) {
        const meta = [`ref=${ref.refId}`];
        if (ref.loc) meta.push(`loc=${ref.loc}`);
        if (ref.url) meta.push(`url=${ref.url}`);
        text += ` [${meta.join(", ")}]`;
      }
      delete ref.url;
    }
    return [{ text, children: VALUE_ROLES.has(role) ? [] : children }];
  }

  #isActionable(role, node, dom) {
    if (role === "root" || role === "text" || role === "label_text") return false;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (axProperty(node, "focusable") === true && role !== "container") return true;
    if (dom?.clickable && !["body", "html"].includes(dom.nodeName)) return true;
    if (axProperty(node, "editable") && axProperty(node, "focusable")) return true;
    return false;
  }

  #isVisible(context, node) {
    if (!context.clip) return true;
    const info = context.dom.nodes.get(node.backendDOMNodeId);
    const rect = info?.layout?.rect;
    if (!rect || info.layout.hidden) return false;
    const x = rect[0] + context.offsetX;
    const y = rect[1] + context.offsetY;
    const clip = context.clip;
    return (
      x < clip.x + clip.width &&
      y < clip.y + clip.height &&
      x + Math.max(rect[2], 1) > clip.x &&
      y + Math.max(rect[3], 1) > clip.y &&
      clip.width > 0 &&
      clip.height > 0
    );
  }

  #addRef(context, role, name, node, dom) {
    const backendNodeId = node.backendDOMNodeId;
    let refId = backendNodeId;
    if (this.#usedRefIds.has(refId)) {
      while (this.#usedRefIds.has(this.#nextSyntheticRef)) this.#nextSyntheticRef += 1;
      refId = this.#nextSyntheticRef++;
    }
    this.#usedRefIds.add(refId);
    const ref = { refId, backendNodeId, role, name };
    if (!context.isMain) ref.frameId = context.frameId;
    if (this.#options.includeStableLocator) {
      const loc = stableLocator(context, role, name, dom);
      if (loc) ref.loc = loc;
    }
    if (role === "link" && dom?.attrs?.href) {
      try {
        ref.url = new URL(dom.attrs.href, context.dom.baseURL || context.url).href;
      } catch {}
    }
    this.#refs.push(ref);
    return ref;
  }
}

function nextNameContext(role, name, inherited) {
  if (name && NAME_FROM_CONTENT.has(role)) return name;
  return inherited;
}

function describeStates(role, node) {
  let text = "";
  if (role === "heading") {
    const level = axProperty(node, "level");
    if (level) text += ` level=${level}`;
  }
  if (VALUE_ROLES.has(role)) {
    const value = node.value?.value;
    if (typeof value === "string" && value.length > 0) text += ` value=${JSON.stringify(value)}`;
  }
  for (const property of STATE_PROPERTIES) {
    const value = axProperty(node, property);
    if (value === undefined || value === false || value === "false") continue;
    text += value === true || value === "true" ? ` ${property}` : ` ${property}=${value}`;
  }
  if (axProperty(node, "focused") === true) text += " focused";
  return text;
}

// Preference order: id, unique role+name, placeholder, aria-label. A link is identified only
// by its href, so a duplicate href yields no locator even when names differ.
function stableLocator(context, role, name, dom) {
  const attrs = dom?.attrs || {};
  const tag = dom?.nodeName;
  const unique = (key, scope) =>
    context.dom.attributeCounts.get(`${key}\u0000${scope}\u0000${attrs[key]}`) === 1;
  if (role === "link") {
    if (tag === "a" && attrs.href && !attrs.href.startsWith("javascript:") && unique("href", "a")) {
      return `href:${attrs.href}`;
    }
    return undefined;
  }
  if (attrs.id && !GENERATED_ID.test(attrs.id) && context.dom.ids.get(attrs.id) === 1) {
    return /^[A-Za-z_][\w-]*$/.test(attrs.id)
      ? `css:#${attrs.id}`
      : `css:[id=${JSON.stringify(attrs.id)}]`;
  }
  const counts = context.ax.roleNameCounts;
  if (name && role !== "container" && role !== "iframe" && counts.get(`${role}\u0000${name}`) === 1) {
    return `role:${role}[name=${JSON.stringify(name)}]`;
  }
  if (attrs.placeholder && (tag === "input" || tag === "textarea") && unique("placeholder", tag)) {
    return `css:${tag}[placeholder=${JSON.stringify(attrs.placeholder)}]`;
  }
  if (attrs["aria-label"] && unique("aria-label", "*")) {
    return `css:[aria-label=${JSON.stringify(attrs["aria-label"])}]`;
  }
  return undefined;
}

function isBlank(text) {
  return text.replace(/[\s\p{Cf}\u00a0]/gu, "") === "";
}

function flatten(node, depth = 0) {
  const lines = [`${"  ".repeat(depth)}${node.text}`];
  for (const child of node.children) lines.push(...flatten(child, depth + 1));
  return lines;
}
