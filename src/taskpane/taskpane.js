/*
 * Simba AI — Excel task pane.
 *
 * Drives a chat UI in the sidebar and runs an agentic loop against the Simba
 * backend (/api/chat), which proxies the Claude API. Claude can request Excel
 * tools (read/write ranges, formulas, selection); those run here via Office.js
 * and the results are fed back until Claude produces a final answer.
 *
 * UI: Claude-inspired theme (light/dark), entrance animations, toast
 * notifications, a settings popup, and an edit-confirmation modal so Simba
 * asks before changing the sheet.
 */

import "./taskpane.css";

// Backend base URL, baked in at build time (see webpack.config.js).
// Empty string = same origin.
const API_BASE = (typeof __SIMBA_API_BASE__ !== "undefined" && __SIMBA_API_BASE__) || "";

const store = {
  get: (k, d) => {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  },
  set: (k, v) => {
    try { localStorage.setItem(k, v); } catch { /* sandboxed */ }
  },
};

let messages = [];
let busy = false;
let editMode = store.get("simba.editMode", "ask"); // auto | ask | off
let modelName = "claude-opus-4-8";

const els = {};

Office.onReady((info) => {
  if (info.host !== Office.HostType.Excel) {
    document.body.innerHTML =
      "<p style='padding:16px;font-family:sans-serif'>Simba AI runs inside Microsoft Excel.</p>";
    return;
  }

  els.messages = document.getElementById("messages");
  els.prompt = document.getElementById("prompt");
  els.send = document.getElementById("send");
  els.newChat = document.getElementById("new-chat");
  els.settings = document.getElementById("settings");
  els.contextPill = document.getElementById("context-pill");
  els.editMode = document.getElementById("edit-mode");
  els.overlay = document.getElementById("modal-overlay");
  els.modalCard = document.getElementById("modal-card");
  els.toasts = document.getElementById("toast-container");

  applyTheme(store.get("simba.theme", "auto"));
  syncEditModeButtons();

  els.send.addEventListener("click", onSend);
  els.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.prompt.addEventListener("input", autoGrow);
  els.newChat.addEventListener("click", resetChat);
  els.settings.addEventListener("click", openSettings);

  els.editMode.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    editMode = btn.dataset.mode;
    store.set("simba.editMode", editMode);
    syncEditModeButtons();
  });

  // Copy buttons inside rendered code blocks (event delegation).
  els.messages.addEventListener("click", (e) => {
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const code = btn.parentElement.querySelector("code");
    copyText(code ? code.textContent : "").then(() => {
      btn.textContent = "Copied";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1400);
    });
  });

  // Close modal on overlay click / Escape.
  els.overlay.addEventListener("mousedown", (e) => {
    if (e.target === els.overlay) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.overlay.hidden) closeModal();
  });

  document.querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => { els.prompt.value = b.textContent; onSend(); })
  );

  refreshContextPill();
  Excel.run(async (ctx) => {
    ctx.workbook.worksheets.onSelectionChanged?.add?.(refreshContextPill);
    await ctx.sync();
  }).catch(() => {});

  // Pull the configured model name for the settings panel (best effort).
  fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((h) => {
    if (h?.model) modelName = h.model;
  }).catch(() => {});
});

/* ------------------------------------------------------------------ *
 * Excel tools — the functions Claude can call.
 * ------------------------------------------------------------------ */

const tools = {
  async get_selection() {
    return Excel.run(async (ctx) => {
      const range = ctx.workbook.getSelectedRange();
      range.load(["address", "values", "rowCount", "columnCount"]);
      await ctx.sync();
      return { address: range.address, rowCount: range.rowCount, columnCount: range.columnCount, values: range.values };
    });
  },

  async read_range({ address }) {
    return Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load(["address", "values", "rowCount", "columnCount"]);
      await ctx.sync();
      return { address: range.address, rowCount: range.rowCount, columnCount: range.columnCount, values: range.values };
    });
  },

  async write_range({ address, values }) {
    const ok = await gateEdit({ kind: "values", address, values });
    if (!ok) return ok === false
      ? { skipped: true, reason: "User declined the edit." }
      : { skipped: true, reason: "Sheet editing is turned off." };
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.values = values;
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address };
    });
    toast(`Wrote ${result.address}`, "success");
    return result;
  },

  async set_formula({ address, formula }) {
    const ok = await gateEdit({ kind: "formula", address, formula });
    if (!ok) return ok === false
      ? { skipped: true, reason: "User declined the edit." }
      : { skipped: true, reason: "Sheet editing is turned off." };
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load(["rowCount", "columnCount"]);
      await ctx.sync();
      const grid = Array.from({ length: range.rowCount }, () =>
        Array.from({ length: range.columnCount }, () => formula));
      range.formulas = grid;
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address, formula };
    });
    toast(`Set formula in ${result.address}`, "success");
    return result;
  },

  async get_sheet_info() {
    return Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const used = sheet.getUsedRangeOrNullObject(true);
      sheet.load("name");
      used.load(["address", "rowCount", "columnCount"]);
      await ctx.sync();
      return {
        sheetName: sheet.name,
        usedRange: used.isNullObject ? null : used.address,
        rowCount: used.isNullObject ? 0 : used.rowCount,
        columnCount: used.isNullObject ? 0 : used.columnCount,
      };
    });
  },
};

/** Returns null (off), false (declined), or true (apply). */
async function gateEdit(details) {
  if (editMode === "off") return null;
  if (editMode === "auto") return true;
  return confirmEdit(details);
}

function parseRange(ctx, address) {
  if (address.includes("!")) {
    const [sheetName, ref] = address.split("!");
    return ctx.workbook.worksheets.getItem(sheetName.replace(/^'|'$/g, "")).getRange(ref);
  }
  return ctx.workbook.worksheets.getActiveWorksheet().getRange(address);
}

/* ------------------------------------------------------------------ *
 * Chat loop
 * ------------------------------------------------------------------ */

async function onSend() {
  const text = els.prompt.value.trim();
  if (!text || busy) return;

  clearWelcome();
  els.prompt.value = "";
  autoGrow();
  els.send.classList.remove("sent");
  void els.send.offsetWidth; // restart animation
  els.send.classList.add("sent");

  let selectionNote = "";
  try {
    const sel = await tools.get_selection();
    selectionNote = `\n\n[Current selection: ${sel.address} (${sel.rowCount}×${sel.columnCount})]`;
  } catch { /* no active selection */ }

  messages.push({ role: "user", content: text + selectionNote });
  renderMessage("user", text);

  setBusy(true);
  const typing = renderTyping();
  try {
    await runAgentLoop();
  } catch (err) {
    toast(err.message || "Something went wrong talking to Simba.", "error", 4000);
  } finally {
    typing.remove();
    setBusy(false);
  }
}

async function runAgentLoop() {
  for (let i = 0; i < 12; i++) {
    const reply = await callBackend(messages);
    messages.push({ role: "assistant", content: reply.content });

    for (const b of reply.content) {
      if (b.type === "text" && b.text.trim()) renderMessage("assistant", b.text);
    }

    if (reply.stop_reason !== "tool_use") return;

    const toolUses = reply.content.filter((b) => b.type === "tool_use");
    const results = [];
    for (const use of toolUses) {
      const note = renderToolNote(use.name, use.input);
      let result, isError = false;
      try {
        const fn = tools[use.name];
        result = fn ? await fn(use.input || {}) : { error: `Unknown tool ${use.name}` };
      } catch (e) {
        result = { error: e.message || String(e) };
        isError = true;
      }
      markToolDone(note);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(result),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: results });
  }
  renderMessage("assistant", "_(Stopped after too many steps. Try narrowing the request.)_");
}

async function callBackend(history) {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: history }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Simba backend error (${res.status}). ${detail}`.trim());
  }
  return res.json();
}

/* ------------------------------------------------------------------ *
 * Popups: confirmation + settings
 * ------------------------------------------------------------------ */

let modalResolver = null;

function openModal(html, { onClose } = {}) {
  els.modalCard.innerHTML = html;
  els.overlay.hidden = false;
  modalResolver = onClose || null;
  const focusable = els.modalCard.querySelector("button, [tabindex]");
  focusable?.focus();
}

function closeModal() {
  if (els.overlay.hidden) return;
  els.overlay.hidden = true;
  const r = modalResolver;
  modalResolver = null;
  if (r) r(false);
}

/** Shows an edit preview; resolves true (apply) / false (cancel). */
function confirmEdit(details) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const body = details.kind === "formula"
      ? `<div class="preview-addr">${escapeHtml(details.address)}</div>
         <div class="preview-formula">${escapeHtml(details.formula)}</div>`
      : `<div class="preview-addr">${escapeHtml(details.address)}</div>
         ${valuesPreviewTable(details.values)}`;

    openModal(
      `<h3>Apply this edit?</h3>
       <p class="sub">Simba wants to ${details.kind === "formula" ? "set a formula" : "write values"}.</p>
       ${body}
       <div class="modal-actions">
         <button class="btn" data-act="cancel">Cancel</button>
         <button class="btn primary" data-act="apply">Apply</button>
       </div>`,
      { onClose: () => finish(false) }
    );

    els.modalCard.querySelector('[data-act="apply"]').onclick = () => { finish(true); closeModalSilently(); };
    els.modalCard.querySelector('[data-act="cancel"]').onclick = () => { finish(false); closeModalSilently(); };
  });
}

// Close without firing the onClose resolver (used after an explicit choice).
function closeModalSilently() {
  els.overlay.hidden = true;
  modalResolver = null;
}

function valuesPreviewTable(values) {
  if (!Array.isArray(values) || !values.length) return '<p class="sub">(empty)</p>';
  const maxR = 6, maxC = 6;
  const rows = values.slice(0, maxR);
  let html = '<table class="preview-table"><tbody>';
  for (const row of rows) {
    const cells = (Array.isArray(row) ? row : [row]).slice(0, maxC);
    html += "<tr>" + cells.map((c) => `<td>${escapeHtml(String(c ?? ""))}</td>`).join("");
    if (Array.isArray(row) && row.length > maxC) html += "<td>…</td>";
    html += "</tr>";
  }
  html += "</tbody></table>";
  if (values.length > maxR) html += `<p class="sub" style="margin-top:8px">+ ${values.length - maxR} more rows</p>`;
  return html;
}

function openSettings() {
  const theme = store.get("simba.theme", "auto");
  openModal(
    `<h3>Settings</h3>
     <div class="setting-row">
       <div><div class="label">Appearance</div><div class="hint">Match system, or force a theme</div></div>
       <div class="seg" id="theme-seg">
         <button class="seg-btn ${theme === "auto" ? "active" : ""}" data-theme="auto">Auto</button>
         <button class="seg-btn ${theme === "light" ? "active" : ""}" data-theme="light">Light</button>
         <button class="seg-btn ${theme === "dark" ? "active" : ""}" data-theme="dark">Dark</button>
       </div>
     </div>
     <div class="setting-row">
       <div><div class="label">Model</div><div class="hint">Powered by Claude</div></div>
       <div class="setting-meta">${escapeHtml(modelName)}</div>
     </div>
     <div class="setting-row">
       <div><div class="label">Conversation</div><div class="hint">Clear the current chat</div></div>
       <button class="btn" id="settings-clear" style="flex:none;padding:7px 12px">New chat</button>
     </div>
     <div class="modal-actions">
       <button class="btn primary" data-act="done">Done</button>
     </div>`
  );

  els.modalCard.querySelector("#theme-seg").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    applyTheme(b.dataset.theme);
    store.set("simba.theme", b.dataset.theme);
    els.modalCard.querySelectorAll("#theme-seg .seg-btn")
      .forEach((x) => x.classList.toggle("active", x === b));
  });
  els.modalCard.querySelector("#settings-clear").onclick = () => { resetChat(); closeModalSilently(); };
  els.modalCard.querySelector('[data-act="done"]').onclick = closeModalSilently;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `
    <div class="avatar">${role === "user" ? "🙂" : "S"}</div>
    <div class="body"><div class="bubble">${formatMarkdown(text)}</div></div>`;
  els.messages.append(wrap);
  scrollDown();
}

function renderToolNote(name, input) {
  const labels = {
    get_selection: "Reading your selection",
    read_range: `Reading ${input?.address || "a range"}`,
    write_range: `Writing to ${input?.address || "a range"}`,
    set_formula: `Setting a formula in ${input?.address || "a range"}`,
    get_sheet_info: "Inspecting the sheet",
  };
  const note = document.createElement("div");
  note.className = "msg assistant";
  note.innerHTML = `<div class="tool-note"><span class="spinner"></span><span class="lbl">${
    escapeHtml(labels[name] || name)
  }</span></div>`;
  els.messages.append(note);
  scrollDown();
  return note;
}

function markToolDone(note) {
  note.querySelector(".tool-note")?.classList.add("done");
}

function renderTyping() {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="avatar">S</div><div class="body"><div class="bubble">
    <span class="typing"><span></span><span></span><span></span></span></div></div>`;
  els.messages.append(el);
  scrollDown();
  return el;
}

/** Minimal, safe markdown: escape HTML, then code/bold/italic + copy buttons. */
function formatMarkdown(text) {
  const esc = escapeHtml(text);
  return esc
    .replace(/```([\s\S]*?)```/g, (_, c) =>
      `<div class="codeblock"><pre><code>${c.replace(/^\n+|\n+$/g, "")}</code></pre>` +
      `<button class="copy-btn" type="button">Copy</button></div>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

function toast(message, type = "info", ms = 2600) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  const icon = type === "success" ? "✓" : type === "error" ? "!" : "•";
  el.innerHTML = `<span class="ic">${icon}</span><span>${escapeHtml(message)}</span>`;
  els.toasts.append(el);
  setTimeout(() => {
    el.classList.add("leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, ms);
}

/* ------------------------------------------------------------------ *
 * UI helpers
 * ------------------------------------------------------------------ */

function applyTheme(theme) {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function syncEditModeButtons() {
  els.editMode.querySelectorAll(".seg-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.mode === editMode));
}

function setBusy(state) {
  busy = state;
  els.send.disabled = state;
  els.prompt.disabled = state;
}

function autoGrow() {
  els.prompt.style.height = "auto";
  els.prompt.style.height = Math.min(els.prompt.scrollHeight, 140) + "px";
}

function scrollDown() {
  els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: "smooth" });
}

function clearWelcome() {
  els.messages.querySelector(".welcome")?.remove();
}

function resetChat() {
  messages = [];
  els.messages.innerHTML =
    '<div class="welcome"><h2>New chat</h2><p>What would you like to do with your spreadsheet?</p></div>';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { /* clipboard may be blocked in the add-in sandbox */ }
}

async function refreshContextPill() {
  try {
    const sel = await tools.get_selection();
    els.contextPill.textContent = `Selected ${sel.address}`;
  } catch {
    els.contextPill.textContent = "No selection";
  }
}
