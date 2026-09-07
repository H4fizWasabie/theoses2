const state = { sessions: [], active: null, history: [], runtime: null, reply: null, tabs: [], activeTab: null, pending: 0, preview: false, filesRoot: "/home", graph: null, liveTurn: null };
const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char]));

if (!$('login') || !$('app')) {
  const fresh = new URL(window.location.href);
  fresh.searchParams.set('fresh', Date.now().toString());
  window.location.replace(fresh.href);
} else {

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showLogin(message = "") {
  $("login").hidden = false;
  $("app").hidden = true;
  $("login-status").textContent = message;
  $("login-token").focus();
}

function showApp() {
  $("login").hidden = true;
  $("app").hidden = false;
}

async function openTelegramSettings() {
  try {
    const data = await request("/api/telegram");
    $("telegram-owner-id").value = data.ownerTelegramId || "";
    $("telegram-token").value = "";
    $("telegram-settings-status").textContent = data.configured ? "Configured. Leave the token blank to keep it." : "Not configured.";
    $("telegram-settings").showModal();
  } catch (error) {
    $("chat-status").textContent = error.message;
  }
}

function relativeTime(value) {
  const age = Date.now() - new Date(value).getTime();
  if (age < 60_000) return "now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  return new Date(value).toLocaleDateString();
}

function renderSessions() {
  const target = $("sessions");
  if (!state.sessions.length) { target.innerHTML = '<div class="empty">No browser sessions yet.</div>'; return; }
  target.innerHTML = state.sessions.map((session) => `<button class="session ${session.id === state.active?.id ? "active" : ""}" data-session="${escapeHtml(session.id)}">
    <span class="session-name">${escapeHtml(session.title)}</span>
    <span class="session-meta"><span class="badge ${session.channel === "telegram" ? "telegram" : ""}">${escapeHtml(session.channel)}</span><span>${session.messageCount} messages</span><span>${relativeTime(session.modified)}</span></span>
  </button>`).join("");
  target.querySelectorAll("[data-session]").forEach((button) => button.addEventListener("click", () => openSession(button.dataset.session)));
}

function flatText(turn) {
  return turn.segments.filter((segment) => segment.type === "text").map((segment) => segment.text).join("");
}

function mergeSegments(segments) {
  const byId = new Map();
  const merged = [];
  for (const segment of segments) {
    if (segment.type === "text") { merged.push({ kind: "text", text: segment.text }); continue; }
    if (segment.type === "tool_call") {
      const entry = { call: segment, result: null };
      byId.set(segment.id, entry);
      merged.push({ kind: "tool", entry });
      continue;
    }
    const existing = byId.get(segment.id);
    if (existing) existing.result = segment;
    else merged.push({ kind: "tool", entry: { call: null, result: segment } });
  }
  return merged;
}

function renderToolBlock(entry) {
  const name = entry.call?.name || entry.result?.name || "tool";
  const status = entry.result ? (entry.result.isError ? "error" : "done") : "running";
  const args = entry.call ? JSON.stringify(entry.call.args, null, 2) : "";
  return `<details class="tool-call ${status}">
    <summary><span class="tool-icon">${status === "running" ? "◌" : status === "error" ? "✕" : "✓"}</span> ${escapeHtml(name)}</summary>
    ${args ? `<pre class="tool-args">${escapeHtml(args)}</pre>` : ""}
    ${entry.result ? `<pre class="tool-result${entry.result.isError ? " error" : ""}">${escapeHtml(entry.result.result)}</pre>` : '<div class="tool-pending">running…</div>'}
  </details>`;
}

function usageBadge(usage) {
  if (!usage) return "";
  const cost = usage.cost ? ` · $${usage.cost.toFixed(4)}` : "";
  return `<span class="usage-badge" title="${usage.input} in / ${usage.output} out">${usage.totalTokens.toLocaleString()} tok${cost}</span>`;
}

function renderTurnBody(turn) {
  if (turn.queued && !turn.segments.length) return '<div class="queued-note">queued…</div>';
  if (turn.pending && !turn.segments.length) return '<div class="thinking"><span></span><span></span><span></span></div>';
  const body = mergeSegments(turn.segments).map((item) => item.kind === "tool" ? renderToolBlock(item.entry) : `<div class="message-text">${escapeHtml(item.text)}</div>`).join("");
  // A tool call finishing doesn't mean the turn is done - theoses may still be producing more
  // text or another tool call. Without this, the UI looks frozen between segments.
  return turn.active ? `${body}<div class="thinking"><span></span><span></span><span></span></div>` : body;
}

function renderHistory() {
  const target = $("messages");
  if (!state.history.length) { target.innerHTML = '<div class="empty">No messages yet.</div>'; }
  else {
    target.innerHTML = state.history.map((turn, index) => `<article class="message"><div class="message-label">${turn.role === "user" ? "You" : "Theoses"}${usageBadge(turn.usage)}</div><div class="message-body">${renderTurnBody(turn)}</div><div class="message-tools"><button class="reply" data-reply="${index}">Reply</button></div></article>`).join("");
    target.querySelectorAll("[data-reply]").forEach((button) => button.addEventListener("click", () => setReply(state.history[Number(button.dataset.reply)])));
    target.scrollTop = target.scrollHeight;
  }
  renderTimeline();
}

function renderTimeline() {
  const target = $("timeline-body");
  if (!target) return;
  const turns = state.history.filter((turn) => turn.role === "assistant");
  if (!turns.length) { target.innerHTML = '<div class="empty">No turns yet.</div>'; return; }
  const recent = turns.slice(-8).reverse();
  target.innerHTML = recent.map((turn, index) => {
    const text = flatText(turn).trim().slice(0, 90) || (turn.active ? "Working…" : "Tool activity");
    const usage = turn.usage;
    const stat = usage ? `$${usage.cost.toFixed(4)}` : turn.active ? "active" : "—";
    return `<div class="turn ${index === 0 && turn.active ? "active" : ""}">
      <div class="turn-top"><span>TURN ${turns.length - index}</span><span>${stat}</span></div>
      <strong>${escapeHtml(text)}</strong>
      <div class="turn-stats"><span>${usage ? `${usage.input.toLocaleString()} in` : "—"}</span><span>${usage ? `${usage.output.toLocaleString()} out` : "—"}</span></div>
    </div>`;
  }).join("");
}

function renderRail() {
  const executing = (state.pending || 0) > 0;
  $("rail-state").textContent = executing ? "EXECUTING" : "IDLE";
  $("rail-state").classList.toggle("live", executing);
  $("rail-provider").textContent = state.runtime?.provider || "—";
  $("rail-model").textContent = state.runtime?.modelId || "—";
  $("rail-thinking").textContent = state.runtime?.thinkingLevel || "—";
  const usage = state.liveTurn?.usage || state.runtime?.lastUsage;
  $("rail-context").textContent = usage ? `${usage.totalTokens.toLocaleString()} tok` : "—";
  $("rail-cost").textContent = usage ? `$${usage.cost.toFixed(4)}` : "—";
}

function setReply(turn) {
  state.reply = turn;
  const bar = $("reply-bar");
  bar.hidden = !turn;
  bar.innerHTML = turn ? `Replying to ${escapeHtml(turn.role)}: ${escapeHtml(flatText(turn).slice(0, 140))} <button class="reply" id="cancel-reply">Cancel</button>` : "";
  $("cancel-reply")?.addEventListener("click", () => setReply(null));
}

function renderActive() {
  const telegram = state.active?.channel === "telegram";
  $("session-title").textContent = state.active?.title || "No dashboard session";
  $("session-channel").textContent = state.active ? ` · ${state.active.channel}` : "";
  $("message").disabled = !state.active || telegram;
  $("message").placeholder = telegram ? "Telegram sessions are read-only" : "Message Theoses…";
  $("chat-form").querySelector(".send").disabled = !state.active || telegram;
  $("stop-chat").hidden = !state.active || telegram || !state.pending;
  renderRail();
}

async function loadSessions() {
  const data = await request("/api/sessions");
  state.sessions = data.sessions;
  renderSessions();
  if (!state.active && state.sessions[0]) await openSession(state.sessions[0].id);
}

async function openSession(id) {
  const data = await request(`/api/sessions/${encodeURIComponent(id)}`);
  state.active = data.session;
  state.history = data.history;
  state.runtime = data.runtime;
  setReply(null); renderSessions(); renderActive(); renderHistory();
}

function openRuntimeInfo() {
  if (!state.active) {
    $("runtime-model").textContent = "No active session";
    $("runtime-provider").textContent = "—";
    $("runtime-thinking").textContent = "—";
    $("runtime-usage").textContent = "—";
    $("runtime-info").showModal();
    return;
  }
  const runtime = state.runtime;
  $("runtime-model").textContent = runtime?.modelId || "Not yet chosen";
  $("runtime-provider").textContent = runtime?.provider || "—";
  $("runtime-thinking").textContent = runtime?.thinkingLevel || "—";
  $("runtime-usage").textContent = runtime?.lastUsage
    ? `${runtime.lastUsage.input.toLocaleString()} in · ${runtime.lastUsage.output.toLocaleString()} out · $${runtime.lastUsage.cost.toFixed(4)}`
    : "No turns yet";
  $("runtime-info").showModal();
}

async function newSession() {
  const session = await request("/api/sessions", { method: "POST" });
  state.sessions.unshift(session);
  await openSession(session.id);
}

function renderTabs() {
  $("tabs").innerHTML = state.tabs.map((tab) => `<div class="tab ${tab.path === state.activeTab ? "active" : ""}"><button data-tab="${escapeHtml(tab.path)}" class="tree-name">${escapeHtml(tab.path.split("/").pop() || tab.path)}</button><button data-close="${escapeHtml(tab.path)}" title="Close">×</button></div>`).join("");
  $("tabs").querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.tab)));
  $("tabs").querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeTab(button.dataset.close)));
}

async function activateTab(path) {
  state.activeTab = path;
  renderTabs();
  const tab = state.tabs.find((item) => item.path === path);
  if (!tab.content) {
    try { Object.assign(tab, await request(`/api/file?path=${encodeURIComponent(path)}`)); }
    catch (error) { $("file-status").textContent = error.message; $("file-status").className = "file-status error"; return; }
  }
  $("file-empty").hidden = true; $("editor").hidden = false; $("file-path").textContent = path; $("file-content").value = tab.content; $("file-preview").textContent = tab.content; $("file-preview-html").srcdoc = tab.content; $("save-file").disabled = false; $("preview-file").disabled = false; $("file-status").textContent = ""; $("file-status").className = "file-status"; setPreview(state.preview);
}

function openFile(path) {
  if (!state.tabs.some((tab) => tab.path === path)) state.tabs.push({ path });
  void activateTab(path);
}

function closeTab(path) {
  state.tabs = state.tabs.filter((tab) => tab.path !== path);
  if (state.activeTab === path) state.activeTab = state.tabs.at(-1)?.path || null;
  renderTabs();
  if (state.activeTab) void activateTab(state.activeTab); else { $("editor").hidden = true; $("file-empty").hidden = false; $("preview-file").disabled = true; }
}

function isHtmlPath(path) {
  return /\.html?$/i.test(path || "");
}

function parentPath(path) {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}

function renderDirectory(entries, target) {
  target.innerHTML = entries.map((entry) => `<div class="tree-row"><span class="tree-kind">${entry.kind === "directory" ? "▸" : "·"}</span><button class="tree-name" data-open="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</button><button class="tree-rename" data-rename="${escapeHtml(entry.path)}" title="Rename">rename</button><button class="tree-delete" data-delete="${escapeHtml(entry.path)}" title="Delete">delete</button></div>`).join("");
  target.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => {
    const entry = entries.find((item) => item.path === button.dataset.open);
    if (entry?.kind === "directory") void loadTree(entry.path); else openFile(entry.path);
  }));
  target.querySelectorAll("[data-rename]").forEach((button) => button.addEventListener("click", () => renameEntry(button.dataset.rename)));
  target.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => deleteEntry(button.dataset.delete)));
}

async function deleteEntry(path) {
  if (!window.confirm(`Delete ${path}? This cannot be undone.`)) return;
  try {
    await request(`/api/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    closeTab(path);
    await loadTree();
  } catch (error) { window.alert(error.message); }
}

async function loadTree(path = state.filesRoot) {
  try {
    const data = await request(`/api/files?path=${encodeURIComponent(path)}`);
    state.filesRoot = data.path;
    $("path-input").value = data.path;
    renderDirectory(data.entries, $("tree"));
  } catch (error) {
    $("tree").innerHTML = `<div class="file-status error">${escapeHtml(error.message)}</div>`;
  }
}

async function renameEntry(path) {
  const current = path.split("/").pop();
  const newName = window.prompt("New name", current);
  if (!newName || newName === current) return;
  try {
    const result = await request("/api/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, newName }) });
    state.tabs.forEach((tab) => { if (tab.path === result.oldPath || tab.path.startsWith(`${result.oldPath}/`)) tab.path = result.newPath + tab.path.slice(result.oldPath.length); });
    if (state.activeTab?.startsWith(result.oldPath)) state.activeTab = result.newPath + state.activeTab.slice(result.oldPath.length);
    renderTabs(); await loadTree(); if (state.activeTab) await activateTab(state.activeTab);
  } catch (error) { window.alert(error.message); }
}

$("save-file").addEventListener("click", async () => {
  const tab = state.tabs.find((item) => item.path === state.activeTab);
  if (!tab) return;
  try {
    const saved = await request("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: tab.path, content: $("file-content").value, version: tab.version }) });
    Object.assign(tab, saved); $("file-content").value = saved.content; $("file-preview").textContent = saved.content; $("file-preview-html").srcdoc = saved.content; $("file-status").textContent = "Saved";
  } catch (error) { $("file-status").textContent = error.message; $("file-status").className = "file-status error"; }
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await request("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: $("login-token").value }) });
    $("login-token").value = "";
    await start();
  } catch (error) {
    showLogin(error.message);
  } finally {
    button.disabled = false;
  }
});

$("runtime-info-button").addEventListener("click", openRuntimeInfo);
$("close-runtime-info").addEventListener("click", () => $("runtime-info").close());
$("telegram-settings-button").addEventListener("click", () => void openTelegramSettings());
$("close-telegram-settings").addEventListener("click", () => $("telegram-settings").close());
$("telegram-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = await request("/api/telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: $("telegram-token").value, ownerTelegramId: $("telegram-owner-id").value }),
    });
    $("telegram-token").value = "";
    $("telegram-settings-status").textContent = data.restartRequired ? "Saved. Restart the Telegram service to apply it." : "Saved.";
  } catch (error) {
    $("telegram-settings-status").textContent = error.message;
    $("telegram-settings-status").className = "file-status error";
  } finally {
    button.disabled = false;
  }
});

function setPreview(enabled) {
  state.preview = enabled;
  const html = isHtmlPath(state.activeTab);
  $("file-content").hidden = enabled;
  $("file-preview").hidden = !enabled || html;
  $("file-preview-html").hidden = !enabled || !html;
  $("preview-file").textContent = enabled ? "Edit" : "Preview";
}

$("preview-file").addEventListener("click", () => setPreview(!state.preview));

function updateLayoutColumns() {
  const layout = document.querySelector(".workbench");
  if (!layout) return;
  if (window.matchMedia("(max-width: 900px)").matches) { layout.style.gridTemplateColumns = "1fr"; return; }
  const colA = document.querySelector(".panel.chat")?.classList.contains("minimized") ? "56px" : "3fr";
  const colB = document.querySelector(".panel.files")?.classList.contains("minimized") ? "56px" : "4fr";
  const colC = document.querySelector(".panel.filesystem")?.classList.contains("minimized") ? "56px" : "3fr";
  layout.style.gridTemplateColumns = `${colA} ${colB} ${colC}`;
}

document.querySelectorAll("[data-minimize]").forEach((button) => button.addEventListener("click", () => {
  button.closest(".panel")?.classList.toggle("minimized");
  updateLayoutColumns();
}));
window.addEventListener("resize", updateLayoutColumns);
updateLayoutColumns();

async function streamSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let eventName = "message"; let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) onEvent(eventName, JSON.parse(data));
    }
  }
}

$("message").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  $("chat-form").requestSubmit();
});

$("chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.active || state.active.channel === "telegram") return;
  const input = $("message"); const message = input.value.trim(); if (!message) return;
  const replyContext = state.reply ? flatText(state.reply) : undefined;
  const sessionId = state.active.id;
  input.value = ""; setReply(null); $("chat-status").textContent = "";

  state.history.push({ role: "user", segments: [{ type: "text", text: message }] });
  const liveTurn = { role: "assistant", segments: [], pending: true, queued: true, active: true };
  state.history.push(liveTurn);
  state.liveTurn = liveTurn;
  state.pending = (state.pending || 0) + 1;
  renderActive();
  renderHistory();

  void (async () => {
    let settled = false;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, replyContext }),
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      await streamSSE(response, (eventName, data) => {
        if (state.active?.id !== sessionId) return;
        if (eventName === "delta") {
          liveTurn.pending = false; liveTurn.queued = false;
          const last = liveTurn.segments.at(-1);
          if (last?.type === "text") last.text += data.text; else liveTurn.segments.push({ type: "text", text: data.text });
        } else if (eventName === "tool_call") {
          liveTurn.pending = false; liveTurn.queued = false;
          liveTurn.segments.push({ type: "tool_call", id: data.id, name: data.name, args: data.args });
        } else if (eventName === "tool_result") {
          liveTurn.segments.push({ type: "tool_result", id: data.id, name: data.name, result: data.result, isError: data.isError });
        } else if (eventName === "usage") {
          liveTurn.usage = data;
          renderRail();
        } else if (eventName === "done") {
          settled = true;
          liveTurn.active = false;
        } else if (eventName === "error") {
          settled = true;
          liveTurn.active = false;
          $("chat-status").textContent = data.message;
        }
        renderHistory();
      });
      if (!settled) {
        liveTurn.active = false; liveTurn.pending = false;
        $("chat-status").textContent = "Connection lost - the response above may be incomplete.";
        renderHistory();
      }
      await loadSessions();
      try {
        const refreshed = await request(`/api/sessions/${encodeURIComponent(sessionId)}`);
        if (state.active?.id === sessionId) { state.runtime = refreshed.runtime; renderRail(); }
      } catch { /* best-effort refresh; the Runtime dialog will still show accurate data on next open */ }
    } catch (error) { liveTurn.active = false; liveTurn.pending = false; $("chat-status").textContent = error.message; renderHistory(); }
    finally { state.pending -= 1; if (state.liveTurn === liveTurn) state.liveTurn = null; renderActive(); }
  })();
});

/** Finds the tool call in the live turn that hasn't gotten its result yet, if any, to report what a stop interrupted. */
function runningToolName(turn) {
  if (!turn) return null;
  const resultIds = new Set(turn.segments.filter((segment) => segment.type === "tool_result").map((segment) => segment.id));
  const call = [...turn.segments].reverse().find((segment) => segment.type === "tool_call" && !resultIds.has(segment.id));
  return call ? call.name : null;
}

$("stop-chat").addEventListener("click", async () => {
  if (!state.active) return;
  const activity = runningToolName(state.liveTurn);
  try {
    await request(`/api/sessions/${encodeURIComponent(state.active.id)}/stop`, { method: "POST" });
    $("chat-status").textContent = activity ? `Halted. Was running: ${activity}.` : "Halted the in-progress reply.";
  } catch (error) {
    $("chat-status").textContent = error.message;
  }
});

// Escape halts the active reply, mirroring the Stop button, unless a dialog (e.g. Telegram settings) is open and should handle it instead.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.active || !state.pending) return;
  if (document.querySelector("dialog[open]")) return;
  event.preventDefault();
  $("stop-chat").click();
});

$("new-session").addEventListener("click", () => void newSession().catch((error) => window.alert(error.message)));
$("refresh-sessions").addEventListener("click", () => void loadSessions());
$("refresh-files").addEventListener("click", () => void loadTree());
$("path-up").addEventListener("click", () => void loadTree(parentPath(state.filesRoot)));
$("path-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void loadTree($("path-input").value.trim() || "/");
});

// --- Obsidian-style force-directed memory graph view ---

const GRAPH_REPULSION = 1800;
const GRAPH_SPRING_LENGTH = 70;
const GRAPH_SPRING_STRENGTH = 0.03;
const GRAPH_DAMPING = 0.85;
const GRAPH_ANCHOR_STRENGTH = 0.025;
const GRAPH_LABEL_ZOOM = 1.4;
const GRAPH_MIN_SCALE = 0.08;
const GRAPH_MAX_SCALE = 4;
const GRAPH_GOLDEN_ANGLE = 2.399963;
const CLUSTER_COLORS = ["#4d6b58", "#4a6fa5", "#a5674a", "#7a4a9c", "#4a9c8a", "#9c4a6f", "#8a9c4a", "#4a5f9c"];
const SOLO_NODE_COLOR = "#b7bab6";
let graphAnimationFrame = null;
let graphDrag = null; // { node, pointerId, moved, startX, startY } | { pan: true, pointerId, startX, startY, originX, originY }
let graphHoverNode = null;
const graphView = { offsetX: 0, offsetY: 0, scale: 1 };

function graphCanvas() { return $("graph-canvas"); }

/** Union-find over edges: nodes connected (directly or transitively) belong to the same cluster. */
function computeGraphClusters(nodes, edges) {
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id) => {
    while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); }
    return id;
  };
  for (const edge of edges) {
    if (!parent.has(edge.source) || !parent.has(edge.target)) continue;
    const rootA = find(edge.source), rootB = find(edge.target);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }
  const groups = new Map();
  for (const node of nodes) {
    const root = find(node.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(node);
  }
  return [...groups.values()].sort((a, b) => b.length - a.length);
}

/** Places each cluster on a sunflower spiral so distinct clusters don't start overlapping, colors them, and seeds node positions/anchors within their cluster. Anchors are gentle attractors the simulation pulls toward, keeping clusters visually distinct instead of collapsing into one blob. */
function layoutGraphClusters(nodes, edges) {
  const clusters = computeGraphClusters(nodes, edges);
  clusters.forEach((cluster, index) => {
    const color = cluster.length > 1 ? CLUSTER_COLORS[index % CLUSTER_COLORS.length] : SOLO_NODE_COLOR;
    const spread = 26 * Math.sqrt(index);
    const angle = index * GRAPH_GOLDEN_ANGLE;
    const anchorX = index === 0 ? 0 : Math.cos(angle) * spread;
    const anchorY = index === 0 ? 0 : Math.sin(angle) * spread;
    cluster.forEach((node, i) => {
      const localAngle = (i / Math.max(cluster.length, 1)) * Math.PI * 2;
      const localRadius = cluster.length > 1 ? 14 + Math.sqrt(cluster.length) * 8 : 0;
      node.anchorX = anchorX + Math.cos(localAngle) * localRadius;
      node.anchorY = anchorY + Math.sin(localAngle) * localRadius;
      node.x = node.anchorX + (Math.random() - 0.5) * 8;
      node.y = node.anchorY + (Math.random() - 0.5) * 8;
      node.vx = 0; node.vy = 0;
      node.clusterColor = color;
      node.clusterSize = cluster.length;
    });
  });
}

function stepGraphSimulation(graph) {
  const { nodes, edges } = graph;
  for (const node of nodes) {
    if (node.pinned) continue;
    let fx = 0, fy = 0;
    for (const other of nodes) {
      if (other === node) continue;
      const dx = node.x - other.x, dy = node.y - other.y;
      const distSq = Math.max(dx * dx + dy * dy, 25);
      const force = GRAPH_REPULSION / distSq;
      const dist = Math.sqrt(distSq);
      fx += (dx / dist) * force; fy += (dy / dist) * force;
    }
    node._fx = fx; node._fy = fy;
  }
  for (const edge of edges) {
    const source = nodes.find((n) => n.id === edge.source);
    const target = nodes.find((n) => n.id === edge.target);
    if (!source || !target) continue;
    const dx = target.x - source.x, dy = target.y - source.y;
    const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
    const stretch = dist - GRAPH_SPRING_LENGTH;
    const force = stretch * GRAPH_SPRING_STRENGTH;
    const fx = (dx / dist) * force, fy = (dy / dist) * force;
    if (!source.pinned) { source._fx += fx; source._fy += fy; }
    if (!target.pinned) { target._fx -= fx; target._fy -= fy; }
  }
  for (const node of nodes) {
    if (node.pinned) continue;
    node._fx += (node.anchorX - node.x) * GRAPH_ANCHOR_STRENGTH;
    node._fy += (node.anchorY - node.y) * GRAPH_ANCHOR_STRENGTH;
    node.vx = (node.vx + node._fx) * GRAPH_DAMPING;
    node.vy = (node.vy + node._fy) * GRAPH_DAMPING;
    node.x += node.vx; node.y += node.vy;
  }
}

function drawGraph(graph) {
  const canvas = graphCanvas();
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr; canvas.height = height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(graphView.offsetX, graphView.offsetY);
  ctx.scale(graphView.scale, graphView.scale);

  ctx.strokeStyle = "#d5d7d3";
  ctx.lineWidth = 1 / graphView.scale;
  for (const edge of graph.edges) {
    const source = graph.nodes.find((n) => n.id === edge.source);
    const target = graph.nodes.find((n) => n.id === edge.target);
    if (!source || !target) continue;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
  }

  const showLabels = graphView.scale >= GRAPH_LABEL_ZOOM;
  // Node dots are sized in screen pixels, not graph space, so they stay visible at any zoom
  // level instead of shrinking toward invisible when the view is fit zoomed all the way out.
  const screenRadius = Math.min(3 + graphView.scale * 2, 8);
  const radius = screenRadius / graphView.scale;
  for (const node of graph.nodes) {
    ctx.beginPath();
    ctx.fillStyle = node.clusterColor || SOLO_NODE_COLOR;
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (showLabels || node === graphHoverNode) {
      ctx.fillStyle = "#202321";
      ctx.font = `${11 / graphView.scale}px Inter, sans-serif`;
      ctx.fillText((node.subject || node.id).slice(0, 60), node.x + radius + 4 / graphView.scale, node.y + 4 / graphView.scale);
    }
  }
  ctx.restore();
}

function graphTick() {
  if (!state.graph) return;
  stepGraphSimulation(state.graph);
  drawGraph(state.graph);
  graphAnimationFrame = requestAnimationFrame(graphTick);
}

function toGraphSpace(clientX, clientY) {
  const canvas = graphCanvas();
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - graphView.offsetX) / graphView.scale,
    y: (clientY - rect.top - graphView.offsetY) / graphView.scale,
  };
}

function findGraphNodeAt(x, y) {
  if (!state.graph) return null;
  const threshold = 8 / graphView.scale;
  return state.graph.nodes.find((node) => (node.x - x) ** 2 + (node.y - y) ** 2 <= threshold * threshold);
}

/** Fits the current node layout to the canvas, zoomed out, so a fresh graph never opens crowded into one corner. */
function fitGraphView() {
  const nodes = state.graph?.nodes;
  if (!nodes || nodes.length === 0) return;
  const canvas = graphCanvas();
  const width = canvas.clientWidth || 800, height = canvas.clientHeight || 600;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x);
    minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y);
  }
  const boxWidth = Math.max(maxX - minX, 1), boxHeight = Math.max(maxY - minY, 1);
  const padding = 80;
  const scale = Math.min((width - padding) / boxWidth, (height - padding) / boxHeight, 1);
  graphView.scale = Math.max(scale, GRAPH_MIN_SCALE);
  graphView.offsetX = width / 2 - graphView.scale * (minX + maxX) / 2;
  graphView.offsetY = height / 2 - graphView.scale * (minY + maxY) / 2;
}

async function loadMemoryGraph() {
  $("graph-status").textContent = "Loading…";
  try {
    const data = await request("/api/memory-graph");
    layoutGraphClusters(data.nodes, data.edges);
    state.graph = data;
    $("graph-empty").hidden = data.nodes.length > 0;
    $("graph-status").textContent = `${data.nodes.length} nodes · ${data.edges.length} edges`;
    fitGraphView();
    if (!graphAnimationFrame) graphTick();
  } catch (error) {
    $("graph-status").textContent = error.message;
  }
}

function openGraphView() {
  $("graph-view").hidden = false;
  void loadMemoryGraph();
}

function closeGraphView() {
  $("graph-view").hidden = true;
  if (graphAnimationFrame) { cancelAnimationFrame(graphAnimationFrame); graphAnimationFrame = null; }
}

$("graph-view-button").addEventListener("click", openGraphView);
$("graph-close").addEventListener("click", closeGraphView);
$("graph-refresh").addEventListener("click", () => void loadMemoryGraph());

graphCanvas().addEventListener("pointerdown", (event) => {
  const point = toGraphSpace(event.clientX, event.clientY);
  const node = findGraphNodeAt(point.x, point.y);
  graphCanvas().setPointerCapture(event.pointerId);
  if (node) {
    node.pinned = true;
    graphDrag = { node, pointerId: event.pointerId, moved: false, startX: event.clientX, startY: event.clientY };
  } else {
    graphDrag = { pan: true, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: graphView.offsetX, originY: graphView.offsetY };
  }
});

graphCanvas().addEventListener("pointermove", (event) => {
  if (!graphDrag || graphDrag.pointerId !== event.pointerId) {
    const point = toGraphSpace(event.clientX, event.clientY);
    graphHoverNode = findGraphNodeAt(point.x, point.y);
    graphCanvas().style.cursor = graphHoverNode ? "pointer" : "grab";
    return;
  }
  if (graphDrag.pan) {
    graphView.offsetX = graphDrag.originX + (event.clientX - graphDrag.startX);
    graphView.offsetY = graphDrag.originY + (event.clientY - graphDrag.startY);
    return;
  }
  const point = toGraphSpace(event.clientX, event.clientY);
  graphDrag.node.x = point.x; graphDrag.node.y = point.y;
  graphDrag.node.vx = 0; graphDrag.node.vy = 0;
  if (Math.abs(event.clientX - graphDrag.startX) > 3 || Math.abs(event.clientY - graphDrag.startY) > 3) graphDrag.moved = true;
});

graphCanvas().addEventListener("pointerup", (event) => {
  if (!graphDrag || graphDrag.pointerId !== event.pointerId) return;
  if (!graphDrag.pan) {
    graphDrag.node.pinned = false;
    if (!graphDrag.moved) {
      closeGraphView();
      openFile(graphDrag.node.path);
    }
  }
  graphDrag = null;
});

graphCanvas().addEventListener("wheel", (event) => {
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.1 : 0.9;
  const nextScale = Math.min(Math.max(graphView.scale * factor, GRAPH_MIN_SCALE), GRAPH_MAX_SCALE);
  const rect = graphCanvas().getBoundingClientRect();
  const cx = event.clientX - rect.left, cy = event.clientY - rect.top;
  // Keep the point under the cursor stationary while the scale changes, so zooming feels anchored, not like it recenters.
  graphView.offsetX = cx - ((cx - graphView.offsetX) / graphView.scale) * nextScale;
  graphView.offsetY = cy - ((cy - graphView.offsetY) / graphView.scale) * nextScale;
  graphView.scale = nextScale;
}, { passive: false });

async function start() {
  try {
    await Promise.all([loadSessions(), loadTree()]);
    showApp();
    const telegram = await request("/api/telegram");
    if (!telegram.configured) await openTelegramSettings();
  } catch (error) {
    if (error.status === 401 || error.status === 503) showLogin(error.message);
    else { showApp(); $("chat-status").textContent = error.message; }
  }
}

void start();
}
