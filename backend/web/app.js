// Dashboard do Motor Local — polling de /api/tasks e /api/history a cada 1,5 s
const POLL_MS = 1500;

const $ = (id) => document.getElementById(id);

function fmtBytes(bytes) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

function fmtEta(eta) {
  if (eta == null) return null;
  const m = Math.floor(eta / 60);
  const s = Math.round(eta % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts * 1000);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function stateLabel(status) {
  return {
    downloading: "⏳ Baixando",
    queued: "🕓 Na fila",
    merging: "🎛️ Juntando áudio e vídeo",
    completed: "✓ Concluído",
    error: "❌ Erro",
    cancelled: "✕ Cancelado",
    interrupted: "⚠️ Interrompido",
  }[status] || status || "";
}

function renderQueue(tasks) {
  const list = $("queue-list");
  const active = (tasks || []).filter((t) =>
    ["downloading", "queued", "merging"].includes(t.status));
  list.innerHTML = "";
  $("queue-empty").classList.toggle("hidden", active.length > 0);
  $("stat-active").textContent = active.length;

  for (const t of active) {
    const pct = Math.max(0, Math.min(100, parseInt(t.progress, 10) || 0));
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = `
      <div class="task-head">
        <span class="task-name" title="${t.title || t.filename || t.url || ""}">${t.title || t.filename || t.url || "..."}</span>
        <span class="task-pct">${pct}%</span>
      </div>
      <div class="task-meta">
        <span>${t.format_label || ""}</span>
        ${t.speed ? `<span>·</span><span>${t.speed}</span>` : ""}
        ${fmtEta(t.eta) ? `<span>·</span><span>restam ${fmtEta(t.eta)}</span>` : ""}
        <span class="task-cancel" data-id="${t.id}">✕ cancelar</span>
      </div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    `;
    list.appendChild(el);
  }
  list.querySelectorAll(".task-cancel").forEach((btn) =>
    btn.addEventListener("click", () => cancelTask(btn.dataset.id)));
}

function renderHistory(history) {
  const list = $("history-list");
  const rows = (history || []).filter((t) =>
    ["completed", "error", "cancelled", "interrupted"].includes(t.status));
  list.innerHTML = "";
  $("history-empty").classList.toggle("hidden", rows.length > 0);

  let doneToday = 0;
  let bytesToday = 0;
  for (const t of rows) {
    if (t.status === "completed" && isToday(t.completed_at || t.created_at)) {
      doneToday += 1;
      bytesToday += t.size || 0;
    }
    const el = document.createElement("div");
    el.className = "history-row";
    el.innerHTML = `
      <span class="history-check">${t.status === "completed" ? "✓" : t.status === "error" ? "❌" : t.status === "cancelled" ? "✕" : "⚠"}</span>
      <span class="history-name" title="${t.title || t.filename || t.url || ""}">${t.title || t.filename || t.url || "..."}</span>
      <span class="history-meta">${t.format_label ? t.format_label + " · " : ""}${t.size ? fmtBytes(t.size) : ""}</span>
      <span class="history-time">${t.completed_at ? new Date(t.completed_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>
      ${t.status === "completed" && t.filename ? `<span class="history-open" data-path="${t.filename}">📂</span>` : ""}
    `;
    list.appendChild(el);
  }
  $("stat-done").textContent = doneToday;
  $("stat-bytes").textContent = fmtBytes(bytesToday);
  list.querySelectorAll(".history-open").forEach((btn) =>
    btn.addEventListener("click", () => openFile(btn.dataset.path)));
}

async function poll() {
  try {
    const [tasksRes, historyRes] = await Promise.all([
      fetch("/api/tasks"), fetch("/api/history"),
    ]);
    if (tasksRes.ok) renderQueue((await tasksRes.json()).tasks);
    if (historyRes.ok) renderHistory((await historyRes.json()).history);
  } catch (e) { /* servidor momentaneamente indisponível */ }
}

async function loadConfig() {
  const r = await fetch("/api/config");
  if (!r.ok) return;
  const cfg = await r.json();
  $("cfg-dir").value = cfg.download_dir || "";
  $("cfg-quality").value = cfg.default_quality || "1080p";
  $("cfg-autostart").checked = !!cfg.autostart;
  $("cfg-notifications").checked = cfg.notifications !== false;
}

async function saveConfig(patch) {
  const r = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (r.ok) {
    const saved = $("config-saved");
    saved.classList.remove("hidden");
    setTimeout(() => saved.classList.add("hidden"), 3000);
  }
}

async function cancelTask(id) {
  await fetch(`/api/cancel/${id}`, { method: "POST" });
}

async function openFile(path) {
  await fetch("/api/open-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

$("btn-open-folder").addEventListener("click", () => fetch("/api/open-folder", { method: "POST" }));
$("btn-stop").addEventListener("click", async () => {
  if (confirm("Parar o Motor Local? Downloads em andamento serão interrompidos.")) {
    await fetch("/api/shutdown", { method: "POST" });
    $("status-pill").className = "pill pill-err";
    $("status-pill").textContent = "● Encerrando...";
  }
});
$("btn-config").addEventListener("click", () => $("config-section").classList.toggle("hidden"));
$("btn-save-dir").addEventListener("click", () => saveConfig({ download_dir: $("cfg-dir").value.trim() }));
$("cfg-quality").addEventListener("change", () => saveConfig({ default_quality: $("cfg-quality").value }));
$("cfg-autostart").addEventListener("change", () => saveConfig({ autostart: $("cfg-autostart").checked }));
$("cfg-notifications").addEventListener("change", () => saveConfig({ notifications: $("cfg-notifications").checked }));

loadConfig();
poll();
setInterval(poll, POLL_MS);
