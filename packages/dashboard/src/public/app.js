const state = { sessions: [], active: null, history: [], reply: null, tabs: [], activeTab: null, busy: false, preview: false };
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

function renderHistory() {
  const target = $("messages");
  if (!state.history.length) { target.innerHTML = '<div class="empty">No messages yet.</div>'; return; }
  target.innerHTML = state.history.map((message, index) => `<article class="message"><div class="message-label">${message.role === "user" ? "You" : "Theoses"}</div><div class="message-body">${escapeHtml(message.content)}</div><div class="message-tools"><button class="reply" data-reply="${index}">Reply</button></div></article>`).join("");
  target.querySelectorAll("[data-reply]").forEach((button) => button.addEventListener("click", () => setReply(state.history[Number(button.dataset.reply)])));
  target.scrollTop = target.scrollHeight;
}

function setReply(message) {
  state.reply = message;
  const bar = $("reply-bar");
  bar.hidden = !message;
  bar.innerHTML = message ? `Replying to ${escapeHtml(message.role)}: ${escapeHtml(message.content.slice(0, 140))} <button class="reply" id="cancel-reply">Cancel</button>` : "";
  $("cancel-reply")?.addEventListener("click", () => setReply(null));
}

function renderActive() {
  const telegram = state.active?.channel === "telegram";
  $("session-title").textContent = state.active?.title || "No dashboard session";
  $("session-channel").textContent = state.active ? ` · ${state.active.channel}` : "";
  $("message").disabled = !state.active || telegram || state.busy;
  $("message").placeholder = telegram ? "Telegram sessions are read-only" : "Message Theoses…";
  $("chat-form").querySelector("button").disabled = !state.active || telegram || state.busy;
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
  setReply(null); renderSessions(); renderActive(); renderHistory();
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
  $("file-empty").hidden = true; $("editor").hidden = false; $("file-path").textContent = path; $("file-content").value = tab.content; $("file-preview").textContent = tab.content; $("save-file").disabled = false; $("preview-file").disabled = false; $("file-status").textContent = ""; $("file-status").className = "file-status"; setPreview(state.preview);
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

function renderDirectory(path, entries, target) {
  target.innerHTML = entries.map((entry) => `<div class="tree-item"><div class="tree-row"><button class="tree-toggle" data-expand="${escapeHtml(entry.path)}">${entry.kind === "directory" ? "▸" : "·"}</button><button class="tree-name" data-open="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</button><button class="tree-rename" data-rename="${escapeHtml(entry.path)}" title="Rename">rename</button></div><div class="tree-children" data-children="${escapeHtml(entry.path)}"></div></div>`).join("");
  target.querySelectorAll("[data-expand]").forEach((button) => button.addEventListener("click", () => toggleDirectory(button.dataset.expand, button)));
  target.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => { const entry = entries.find((item) => item.path === button.dataset.open); if (entry?.kind === "directory") toggleDirectory(entry.path, button.previousElementSibling); else openFile(entry.path); }));
  target.querySelectorAll("[data-rename]").forEach((button) => button.addEventListener("click", () => renameEntry(button.dataset.rename)));
}

async function toggleDirectory(path, button) {
  const child = button.parentElement.nextElementSibling;
  if (child.childElementCount) { child.replaceChildren(); button.textContent = "▸"; return; }
  try { const data = await request(`/api/files?path=${encodeURIComponent(path)}`); renderDirectory(path, data.entries, child); button.textContent = "▾"; }
  catch (error) { child.innerHTML = `<div class="file-status error">${escapeHtml(error.message)}</div>`; }
}

async function loadTree() {
  const data = await request("/api/files?path=%2F");
  renderDirectory("/", data.entries, $("tree"));
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
    Object.assign(tab, saved); $("file-content").value = saved.content; $("file-preview").textContent = saved.content; $("file-status").textContent = "Saved";
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
  $("file-content").hidden = enabled;
  $("file-preview").hidden = !enabled;
  $("preview-file").textContent = enabled ? "Edit" : "Preview";
}

$("preview-file").addEventListener("click", () => setPreview(!state.preview));

function togglePanel(name) {
  const mobile = window.matchMedia("(max-width: 640px)").matches;
  const panel = document.querySelector(name === "sidebar" ? ".sidebar" : ".file-pane");
  if (mobile) panel.classList.toggle("open");
  else $(".shell").classList.toggle(`${name}-collapsed`);
}

$("toggle-sidebar").addEventListener("click", () => togglePanel("sidebar"));
$("toggle-files").addEventListener("click", () => togglePanel("files"));

document.querySelectorAll("[data-resize]").forEach((handle) => handle.addEventListener("pointerdown", (event) => {
  const shell = $(".shell");
  const start = event.clientX;
  const variable = handle.dataset.resize === "sidebar" ? "--sidebar-width" : "--files-width";
  const initial = handle.dataset.resize === "sidebar" ? $(".sidebar").getBoundingClientRect().width : $(".file-pane").getBoundingClientRect().width;
  handle.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    const delta = moveEvent.clientX - start;
    const width = Math.max(180, initial + (handle.dataset.resize === "sidebar" ? delta : -delta));
    shell.style.setProperty(variable, `${width}px`);
  };
  const stop = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); };
  handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", stop);
}));

$("chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.active || state.active.channel === "telegram") return;
  const input = $("message"); const message = input.value.trim(); if (!message) return;
  state.busy = true; renderActive(); input.value = "";
  try {
    const data = await request(`/api/sessions/${encodeURIComponent(state.active.id)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, replyContext: state.reply?.content }) });
    state.history = data.history; setReply(null); renderHistory(); await loadSessions();
  } catch (error) { $("chat-status").textContent = error.message; }
  finally { state.busy = false; renderActive(); }
});

$("new-session").addEventListener("click", () => void newSession().catch((error) => window.alert(error.message)));
$("refresh-sessions").addEventListener("click", () => void loadSessions());
$("refresh-files").addEventListener("click", () => void loadTree());

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
