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

// Simba's mascot — a Pomeranian. Used for the brand mark and assistant avatars.
const POM_SVG = `
<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <polygon points="6.4,10.2 9.9,0.6 15,8.6" fill="#c2693a"/>
  <polygon points="25.6,10.2 22.1,0.6 17,8.6" fill="#c2693a"/>
  <polygon points="8.6,8.6 10.6,3.5 13.8,8.3" fill="#f3b58a"/>
  <polygon points="23.4,8.6 21.4,3.5 18.2,8.3" fill="#f3b58a"/>
  <circle cx="16" cy="17.9" r="12.8" fill="#e08a4f"/>
  <circle cx="16" cy="20.5" r="9.6" fill="#f1c9a0"/>
  <ellipse cx="16" cy="23" rx="6.6" ry="5" fill="#fbf0e2"/>
  <circle cx="12.3" cy="16" r="1.7" fill="#36281e"/>
  <circle cx="19.7" cy="16" r="1.7" fill="#36281e"/>
  <circle cx="12.9" cy="15.5" r="0.6" fill="#fff"/>
  <circle cx="20.3" cy="15.5" r="0.6" fill="#fff"/>
  <ellipse cx="16" cy="20.6" rx="1.7" ry="1.2" fill="#36281e"/>
</svg>`;

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
  document.querySelector(".brand-mark").innerHTML = POM_SVG;

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

  window.addEventListener("unhandledrejection", (e) => console.error("[Simba] unhandled rejection:", e.reason));
  window.addEventListener("error", (e) => console.error("[Simba] error:", e.message));

  refreshContextPill();
  Excel.run(async (ctx) => {
    ctx.workbook.worksheets.onSelectionChanged?.add?.(refreshContextPill);
    await ctx.sync();
  }).catch(() => {});

  // Pull the configured model name for the settings panel (best effort).
  fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((h) => {
    if (h?.model) modelName = h.model;
  }).catch(() => {});

  // One-time onboarding tip on first open.
  if (!store.get("simba.onboarded", "")) setTimeout(showOnboarding, 450);
});

/* ------------------------------------------------------------------ *
 * Excel tools — the functions Claude can call.
 * ------------------------------------------------------------------ */

const tools = {
  /* ---------------- read / inspect (no confirmation) ---------------- */

  async get_selection() {
    return Excel.run(async (ctx) => {
      const range = ctx.workbook.getSelectedRange();
      range.load(["address", "values", "formulas", "rowCount", "columnCount"]);
      await ctx.sync();
      const out = { address: range.address, rowCount: range.rowCount, columnCount: range.columnCount, values: range.values, formulas: range.formulas };
      const cap = capValues(out.values);
      if (cap.truncated) {
        out.values = cap.values;
        out.formulas = out.formulas.slice(0, cap.shownRows);
        out.truncated = true;
        out.note = `Showing the first ${cap.shownRows} of ${cap.totalRows} rows (capped for size).`;
      }
      return out;
    });
  },

  async read_range({ address, include_formulas }) {
    return Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      const props = ["address", "values", "rowCount", "columnCount"];
      if (include_formulas) props.push("formulas", "numberFormat");
      range.load(props);
      await ctx.sync();
      const out = { address: range.address, rowCount: range.rowCount, columnCount: range.columnCount, values: range.values };
      if (include_formulas) { out.formulas = range.formulas; out.numberFormat = range.numberFormat; }
      const cap = capValues(out.values);
      if (cap.truncated) {
        out.values = cap.values;
        if (out.formulas) out.formulas = out.formulas.slice(0, cap.shownRows);
        out.truncated = true;
        out.note = `Showing the first ${cap.shownRows} of ${cap.totalRows} rows (capped for size). Read a smaller range for everything.`;
      }
      return out;
    });
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

  async list_sheets() {
    return Excel.run(async (ctx) => {
      const sheets = ctx.workbook.worksheets;
      const active = ctx.workbook.worksheets.getActiveWorksheet();
      sheets.load("items/name,items/position,items/visibility");
      active.load("name");
      await ctx.sync();
      return {
        active: active.name,
        sheets: sheets.items.map((s) => ({ name: s.name, position: s.position, visibility: s.visibility })),
      };
    });
  },

  async find({ query, match_case = false }) {
    return Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const used = sheet.getUsedRangeOrNullObject(true);
      used.load(["values", "rowIndex", "columnIndex"]);
      await ctx.sync();
      if (used.isNullObject) return { matches: [], count: 0 };
      const q = match_case ? String(query) : String(query).toLowerCase();
      const matches = [];
      for (let r = 0; r < used.values.length && matches.length < 200; r++) {
        for (let c = 0; c < used.values[r].length; c++) {
          const cell = used.values[r][c];
          if (cell === "" || cell === null) continue;
          const hay = match_case ? String(cell) : String(cell).toLowerCase();
          if (hay.includes(q)) {
            matches.push({ address: `${colLetter(used.columnIndex + c)}${used.rowIndex + r + 1}`, value: cell });
            if (matches.length >= 200) break;
          }
        }
      }
      return { matches, count: matches.length, truncated: matches.length >= 200 };
    });
  },

  /* ---------------- write / mutate (gated by edit mode) ---------------- */

  async write_range({ address, values }) {
    if (!is2DArray(values)) return { error: "values must be a non-empty 2D array (rows of columns)." };
    const ok = await gateEdit({ kind: "values", address, values });
    if (!ok) return declined(ok);
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
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load(["rowCount", "columnCount"]);
      await ctx.sync();
      range.formulas = grid(range.rowCount, range.columnCount, formula);
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address, formula };
    });
    toast(`Set formula in ${result.address}`, "success");
    return result;
  },

  async set_formulas({ address, formulas }) {
    if (!is2DArray(formulas)) return { error: "formulas must be a non-empty 2D array of formula strings." };
    const ok = await gateEdit({ kind: "values", address, values: formulas });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.formulas = formulas;
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address };
    });
    toast(`Set formulas in ${result.address}`, "success");
    return result;
  },

  async clear_range({ address, what = "contents" }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Clear ${what} of ${address}` });
    if (!ok) return declined(ok);
    const map = { contents: "Contents", formats: "Formats", all: "All" };
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.clear(map[what] || "Contents");
      range.load("address");
      await ctx.sync();
      return { cleared: true, address: range.address, what };
    });
    toast(`Cleared ${result.address}`, "success");
    return result;
  },

  async format_range(opts) {
    const { address } = opts;
    const ok = await gateEdit({ kind: "edit", address, summary: describeFormat(opts) });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      const f = range.format;
      if (opts.bold != null) f.font.bold = !!opts.bold;
      if (opts.italic != null) f.font.italic = !!opts.italic;
      if (opts.underline != null) f.font.underline = opts.underline ? "Single" : "None";
      if (opts.font_color) f.font.color = opts.font_color;
      if (opts.font_size != null) f.font.size = opts.font_size;
      if (opts.fill_color) f.fill.color = opts.fill_color;
      if (opts.align) f.horizontalAlignment = cap(opts.align);
      if (opts.wrap != null) f.wrapText = !!opts.wrap;
      if (opts.number_format) {
        range.load(["rowCount", "columnCount"]);
        await ctx.sync();
        range.numberFormat = grid(range.rowCount, range.columnCount, opts.number_format);
      }
      range.load("address");
      await ctx.sync();
      return { formatted: true, address: range.address };
    });
    toast(`Formatted ${result.address}`, "success");
    return result;
  },

  async insert_rows({ index, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Insert ${count} row(s) above row ${index}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(`${index}:${index + count - 1}`).insert("Down");
      await ctx.sync();
    });
    toast(`Inserted ${count} row(s)`, "success");
    return { inserted: true, rows: count, at: index };
  },

  async delete_rows({ index, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Delete ${count} row(s) starting at row ${index}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(`${index}:${index + count - 1}`).delete("Up");
      await ctx.sync();
    });
    toast(`Deleted ${count} row(s)`, "success");
    return { deleted: true, rows: count, at: index };
  },

  async insert_columns({ column, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Insert ${count} column(s) before ${column}` });
    if (!ok) return declined(ok);
    const start = colIndex(column);
    const ref = `${colLetter(start)}:${colLetter(start + count - 1)}`;
    await Excel.run(async (ctx) => {
      ctx.workbook.worksheets.getActiveWorksheet().getRange(ref).insert("Right");
      await ctx.sync();
    });
    toast(`Inserted ${count} column(s)`, "success");
    return { inserted: true, columns: count, before: column };
  },

  async delete_columns({ column, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Delete ${count} column(s) starting at ${column}` });
    if (!ok) return declined(ok);
    const start = colIndex(column);
    const ref = `${colLetter(start)}:${colLetter(start + count - 1)}`;
    await Excel.run(async (ctx) => {
      ctx.workbook.worksheets.getActiveWorksheet().getRange(ref).delete("Left");
      await ctx.sync();
    });
    toast(`Deleted ${count} column(s)`, "success");
    return { deleted: true, columns: count, at: column };
  },

  async sort_range({ address, column_index = 0, ascending = true, has_headers = true }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Sort ${address} by column ${column_index + 1} ${ascending ? "A→Z" : "Z→A"}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.sort.apply([{ key: column_index, ascending }], false, has_headers, "Rows");
      await ctx.sync();
    });
    toast(`Sorted ${address}`, "success");
    return { sorted: true, address };
  },

  async autofit({ address }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Autofit ${address}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.format.autofitColumns();
      range.format.autofitRows();
      await ctx.sync();
    });
    return { autofit: true, address };
  },

  async create_table({ address, has_headers = true, name }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Create a table from ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const table = sheet.tables.add(address, has_headers);
      if (name) table.name = name;
      table.load("name");
      await ctx.sync();
      return { created: true, table: table.name };
    });
    toast(`Created table ${result.table}`, "success");
    return result;
  },

  async create_chart({ data_range, chart_type = "ColumnClustered", title }) {
    const ok = await gateEdit({ kind: "edit", address: data_range, summary: `Create a ${chart_type} chart from ${data_range}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const chart = sheet.charts.add(chart_type, parseRange(ctx, data_range), "Auto");
      if (title) chart.title.text = title;
      chart.load("name");
      await ctx.sync();
      return { created: true, chart: chart.name };
    });
    toast("Created chart", "success");
    return result;
  },

  async add_sheet({ name }) {
    const ok = await gateEdit({ kind: "edit", summary: `Add a new sheet${name ? ` named "${name}"` : ""}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const ws = ctx.workbook.worksheets.add(name || undefined);
      ws.activate();
      ws.load("name");
      await ctx.sync();
      return { created: true, sheet: ws.name };
    });
    toast(`Added sheet ${result.sheet}`, "success");
    return result;
  },

  async select_range({ address }) {
    return Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.select();
      range.load("address");
      await ctx.sync();
      refreshContextPill();
      return { selected: true, address: range.address };
    });
  },
};

/* tool helpers */
const MAX_READ_CELLS = 20000;
function is2DArray(v) { return Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r)); }
function capValues(values) {
  if (!Array.isArray(values) || values.length === 0) return { truncated: false };
  const cols = Array.isArray(values[0]) ? Math.max(1, values[0].length) : 1;
  const maxRows = Math.max(1, Math.floor(MAX_READ_CELLS / cols));
  if (values.length <= maxRows) return { truncated: false };
  return { truncated: true, values: values.slice(0, maxRows), shownRows: maxRows, totalRows: values.length };
}
function declined(ok) {
  return ok === false
    ? { skipped: true, reason: "User declined the edit." }
    : { skipped: true, reason: "Sheet editing is turned off." };
}
function grid(rows, cols, val) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => val));
}
function colLetter(n) {
  let s = "";
  n++;
  while (n) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}
function colIndex(letter) {
  const L = String(letter).toUpperCase().replace(/[^A-Z]/g, "");
  let n = 0;
  for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function cap(s) {
  s = String(s).toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function describeFormat(o) {
  const bits = [];
  if (o.bold) bits.push("bold");
  if (o.italic) bits.push("italic");
  if (o.underline) bits.push("underline");
  if (o.font_color) bits.push(`text ${o.font_color}`);
  if (o.fill_color) bits.push(`fill ${o.fill_color}`);
  if (o.font_size) bits.push(`size ${o.font_size}`);
  if (o.align) bits.push(`align ${o.align}`);
  if (o.wrap) bits.push("wrap text");
  if (o.number_format) bits.push(`format "${o.number_format}"`);
  return `Format ${o.address}${bits.length ? ": " + bits.join(", ") : ""}`;
}

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
    if (!reply || !Array.isArray(reply.content)) throw new Error("Simba returned an unexpected response.");
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
      if (result && result.error) isError = true;
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
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let res;
  try {
    res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(
      e && e.name === "AbortError"
        ? "Simba took too long to respond. Please try again."
        : "Can't reach Simba. Check your connection and that the backend is running."
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = `Simba backend error (${res.status}).`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* non-JSON */ }
    throw new Error(msg);
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

    const addrPill = details.address
      ? `<div class="preview-addr">${escapeHtml(details.address)}</div>` : "";

    let body, sub;
    if (details.kind === "formula") {
      sub = "Simba wants to set a formula.";
      body = `${addrPill}<div class="preview-formula">${escapeHtml(details.formula)}</div>`;
    } else if (details.kind === "values") {
      sub = "Simba wants to write to the sheet.";
      body = `${addrPill}${valuesPreviewTable(details.values)}`;
    } else {
      sub = "Simba wants to edit the sheet.";
      body = `${addrPill}<p class="confirm-summary">${escapeHtml(details.summary || "Apply this change?")}</p>`;
    }

    openModal(
      `<h3>Apply this edit?</h3>
       <p class="sub">${sub}</p>
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
    <div class="avatar">${role === "user" ? "🙂" : POM_SVG}</div>
    <div class="body"><div class="bubble">${formatMarkdown(text)}</div></div>`;
  els.messages.append(wrap);
  scrollDown();
}

function renderToolNote(name, input) {
  const labels = {
    get_selection: "Reading your selection",
    read_range: `Reading ${input?.address || "a range"}`,
    get_sheet_info: "Inspecting the sheet",
    list_sheets: "Looking at the workbook",
    find: `Searching for "${input?.query || ""}"`,
    write_range: `Writing to ${input?.address || "a range"}`,
    set_formula: `Setting a formula in ${input?.address || "a range"}`,
    set_formulas: `Setting formulas in ${input?.address || "a range"}`,
    clear_range: `Clearing ${input?.address || "a range"}`,
    format_range: `Formatting ${input?.address || "a range"}`,
    insert_rows: "Inserting rows",
    delete_rows: "Deleting rows",
    insert_columns: "Inserting columns",
    delete_columns: "Deleting columns",
    sort_range: `Sorting ${input?.address || "a range"}`,
    autofit: "Autofitting cells",
    create_table: `Creating a table from ${input?.address || "a range"}`,
    create_chart: "Creating a chart",
    add_sheet: "Adding a sheet",
    select_range: `Selecting ${input?.address || "a range"}`,
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
  el.innerHTML = `<div class="avatar">${POM_SVG}</div><div class="body"><div class="bubble">
    <span class="typing"><span></span><span></span><span></span></span></div></div>`;
  els.messages.append(el);
  scrollDown();
  return el;
}

/** Minimal, safe markdown: fenced code (highlighted), inline code, bold, italic. */
function formatMarkdown(text) {
  // Pull fenced code out of the RAW text first so highlighting sees real chars.
  const blocks = [];
  const stripped = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const html =
      `<div class="codeblock"><pre><code>${highlight(code.replace(/\n+$/, ""), lang)}</code></pre>` +
      `<button class="copy-btn" type="button">Copy</button></div>`;
    blocks.push(html);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  let out = escapeHtml(stripped)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

/* ------------------------------------------------------------------ *
 * Lightweight syntax highlighting (no dependency).
 * Tuned for Excel formulas, with a generic fallback for other code.
 * ------------------------------------------------------------------ */

const GENERIC_KW = new Set(
  ("const let var function return if else for while do switch case break continue class new " +
   "import from export default async await try catch finally throw typeof instanceof in of " +
   "def elif lambda pass yield with print true false null none and or not " +
   "select insert update delete where group order by join on as").split(" ")
);

const FORMULA_RULES = [
  { re: /"(?:[^"]|"")*"/y, cls: "tok-str" },
  { re: /\b[A-Z][A-Z0-9_.]*(?=\s*\()/y, cls: "tok-func" },
  { re: /\b(?:TRUE|FALSE)\b/y, cls: "tok-kw" },
  { re: /\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?\b/y, cls: "tok-ref" },
  { re: /\d+(?:\.\d+)?/y, cls: "tok-num" },
  { re: /[-+*/^&=<>%]/y, cls: "tok-op" },
];

const GENERIC_RULES = [
  { re: /\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\//y, cls: "tok-com" },
  { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y, cls: "tok-str" },
  { re: /\b\d[\d_]*(?:\.\d+)?\b/y, cls: "tok-num" },
  { re: /[A-Za-z_]\w*(?=\s*\()/y, cls: "tok-func" },
  { re: /[A-Za-z_]\w*/y, fn: (t) => (GENERIC_KW.has(t.toLowerCase()) ? "tok-kw" : null) },
];

function highlight(code, lang) {
  const l = (lang || "").toLowerCase();
  const isFormula =
    l === "excel" || l === "formula" || l === "xls" ||
    (!l && code.trim().startsWith("="));
  return tokenize(code, isFormula ? FORMULA_RULES : GENERIC_RULES);
}

function tokenize(code, rules) {
  let out = "", i = 0;
  while (i < code.length) {
    let matched = false;
    for (const r of rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(code);
      if (m && m.index === i && m[0].length) {
        const cls = r.cls || (r.fn && r.fn(m[0]));
        const t = escapeHtml(m[0]);
        out += cls ? `<span class="${cls}">${t}</span>` : t;
        i += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) { out += escapeHtml(code[i]); i++; }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Onboarding — a polished multi-step welcome shown once on first open.
 * ------------------------------------------------------------------ */

function onbGridArt() {
  let cells = "";
  for (let i = 0; i < 12; i++) {
    const delay = ((i % 4) * 0.12 + Math.floor(i / 4) * 0.14).toFixed(2);
    cells += `<span class="gcell" style="animation-delay:${delay}s"></span>`;
  }
  return `<div class="onb-art art-grid"><div class="ggrid">${cells}</div>
    <span class="gcursor"></span></div>`;
}

function onbFormulaArt() {
  return `<div class="onb-art art-fx">
    <div class="fxbar">
      <span class="fxlabel">fx</span>
      <span class="fxclip"><span class="fxtext"><span class="tok-op">=</span><span class="tok-func">SUM</span><span class="tok-op">(</span><span class="tok-ref">B2:B9</span><span class="tok-op">)</span></span></span>
      <span class="fxcaret"></span>
    </div>
    <div class="fxcell">↳ 1,248</div>
  </div>`;
}

function onbModesArt() {
  return `<div class="onb-art art-modes">
    <span class="mchip active">Ask</span>
    <span class="mchip">Auto</span>
    <span class="mchip">Off</span>
  </div>`;
}

function onbHelloArt() {
  return `<div class="onb-art art-hello">
    <span class="spark s1">✦</span><span class="spark s2">✦</span><span class="spark s3">✦</span>
    <div class="pom-tile">${POM_SVG}</div>
  </div>`;
}

const ONB_STEPS = [
  {
    art: onbHelloArt,
    title: "Meet Simba",
    body: "Your AI sidekick for Excel — a curious little Pomeranian that lives in your spreadsheet and helps you get real work done, fast.",
  },
  {
    art: onbGridArt,
    title: "I understand your data",
    body: "Select any range and ask in plain English. I'll read your cells, summarize them, spot trends, and answer questions — no formula-wrangling required.",
  },
  {
    art: onbFormulaArt,
    title: "And I'll do the work",
    body: "Ask me to clean a column, build a formula, or fill in values, and I'll write them straight into your sheet — with a preview so you see exactly what changes.",
  },
  {
    art: onbModesArt,
    title: "You're always in control",
    body: "By default I <strong>ask</strong> before editing. Switch to <strong>Auto</strong> to let me apply changes, or <strong>Off</strong> to stay read-only — anytime, from the bar below.",
    cta: "Start using Simba",
  },
];

function showOnboarding() {
  if (document.querySelector(".onb-backdrop")) return;

  let step = 0;
  const bd = document.createElement("div");
  bd.className = "onb-backdrop";
  bd.innerHTML = `
    <div class="onb-modal" role="dialog" aria-modal="true" aria-label="Welcome to Simba">
      <button class="onb-skip" type="button">Skip</button>
      <div class="onb-stage"></div>
      <div class="onb-foot">
        <div class="onb-dots" role="tablist"></div>
        <div class="onb-nav">
          <button class="btn onb-back" type="button">Back</button>
          <button class="btn primary onb-next" type="button">Next</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const stage = bd.querySelector(".onb-stage");
  const dots = bd.querySelector(".onb-dots");
  const back = bd.querySelector(".onb-back");
  const next = bd.querySelector(".onb-next");

  ONB_STEPS.forEach((_, i) => {
    const d = document.createElement("button");
    d.className = "onb-dot";
    d.type = "button";
    d.setAttribute("aria-label", `Step ${i + 1}`);
    d.addEventListener("click", () => go(i));
    dots.appendChild(d);
  });

  function render(dir) {
    const s = ONB_STEPS[step];
    const el = document.createElement("div");
    el.className = "onb-step " + (dir >= 0 ? "enter-right" : "enter-left");
    el.innerHTML = `${s.art()}
      <h3 class="onb-title">${s.title}</h3>
      <p class="onb-body">${s.body}</p>`;
    const old = stage.querySelector(".onb-step");
    if (old) {
      old.className = "onb-step " + (dir >= 0 ? "leave-left" : "leave-right");
      old.addEventListener("animationend", () => old.remove(), { once: true });
    }
    stage.appendChild(el);

    [...dots.children].forEach((d, i) => {
      d.classList.toggle("active", i === step);
      d.setAttribute("aria-selected", i === step ? "true" : "false");
    });
    back.style.visibility = step === 0 ? "hidden" : "visible";
    next.textContent = s.cta || "Next";
    next.classList.toggle("final", Boolean(s.cta));
  }

  function go(i) {
    if (i < 0 || i >= ONB_STEPS.length || i === step) return;
    const dir = i >= step ? 1 : -1;
    step = i;
    render(dir);
  }

  function finish() {
    store.set("simba.onboarded", "1");
    bd.classList.add("closing");
    document.removeEventListener("keydown", onKey);
    setTimeout(() => bd.remove(), 240);
    toast("Tip: select some cells, then ask Simba about them", "info", 3400);
  }

  function onKey(e) {
    if (!document.body.contains(bd)) { document.removeEventListener("keydown", onKey); return; }
    if (e.key === "Escape") finish();
    else if (e.key === "ArrowRight") (step === ONB_STEPS.length - 1 ? finish() : go(step + 1));
    else if (e.key === "ArrowLeft") go(step - 1);
  }

  back.addEventListener("click", () => go(step - 1));
  next.addEventListener("click", () => (step === ONB_STEPS.length - 1 ? finish() : go(step + 1)));
  bd.querySelector(".onb-skip").addEventListener("click", finish);
  bd.addEventListener("mousedown", (e) => { if (e.target === bd) finish(); });
  document.addEventListener("keydown", onKey);

  render(1);
  setTimeout(() => next.focus(), 60);
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
  if (busy) { toast("Hold on — Simba is still working.", "info"); return; }
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
