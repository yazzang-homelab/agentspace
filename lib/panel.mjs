// Control panel: the Linux replacement for agentspace's Space sidebar. It shows
// every Space, the agent's progress text, and lets the user take control of an
// Agent space or hand it back.

export function renderPanel() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>agentspace — Spaces</title>
<style>
  :root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
  body { margin: 0; padding: 16px; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  .space { border: 1px solid #8884; border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
  .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  .name { font-weight: 600; }
  .badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: #8883; }
  .agent { background: #ff5c0033; }
  .delegated { background: #2a7cff33; }
  .state { margin-top: 4px; color: #888; }
  .tabs { margin-top: 4px; font-size: 12px; color: #888; }
  button { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid #8886; background: transparent; cursor: pointer; }
  .empty { color: #888; }
</style>
</head>
<body>
<h1>agentspace Spaces <span id="version" class="badge"></span></h1>
<div id="spaces" class="empty">Loading…</div>
<script>
const token = new URLSearchParams(location.search).get("token");
const api = (path, method = "GET") =>
  fetch(path + "?token=" + encodeURIComponent(token), { method }).then((r) => r.json());
const label = { agent: "Agent working", agentDelegatedToUser: "You are in control", user: "Yours" };
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
}
async function act(id, action) {
  const result = await api("/api/spaces/" + id + "/" + action, "POST");
  if (result.error) alert(result.error);
  refresh();
}
async function refresh() {
  const data = await api("/api/spaces");
  document.getElementById("version").textContent = data.version;
  const root = document.getElementById("spaces");
  root.replaceChildren();
  root.className = data.spaces.length ? "" : "empty";
  if (!data.spaces.length) root.textContent = "No Spaces yet.";
  for (const space of data.spaces) {
    const buttons = [];
    if (space.ownership === "agent") {
      buttons.push(el("button", { textContent: "Take control", onclick: () => act(space.id, "take-control") }));
      buttons.push(el("button", { textContent: "Stop & close", onclick: () => act(space.id, "close") }));
    } else if (space.ownership === "agentDelegatedToUser") {
      buttons.push(el("button", { textContent: "Return to agent", onclick: () => act(space.id, "return-control") }));
    }
    const badgeClass = space.ownership === "agent" ? "agent" : space.ownership === "agentDelegatedToUser" ? "delegated" : "";
    root.append(
      el("div", { className: "space" }, [
        el("div", { className: "row" }, [
          el("span", {}, [
            el("span", { className: "name", textContent: space.name + " " }),
            el("span", { className: "badge " + badgeClass, textContent: label[space.ownership] || space.ownership }),
            el("span", { className: "badge", textContent: " #" + space.id + " · " + (space.profileName || space.profileId) }),
          ]),
          el("span", {}, buttons),
        ]),
        el("div", { className: "state", textContent: space.agentState || (space.controlReason ? "Reason: " + space.controlReason : "") }),
        el("div", { className: "tabs", textContent: (space.recentTabTitles || []).join(" · ") }),
      ]),
    );
  }
}
refresh();
setInterval(refresh, 1500);
</script>
</body>
</html>`;
}
