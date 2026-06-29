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
<svg viewBox="0 0 64 80" aria-hidden="true" focusable="false">
  <ellipse cx="13" cy="48" rx="9" ry="11" fill="#e89a52"/>
  <ellipse cx="13" cy="48" rx="5" ry="7" fill="#f6d3a6"/>
  <ellipse cx="32" cy="52" rx="22" ry="24" fill="#f0a35c"/>
  <ellipse cx="32" cy="56" rx="13.5" ry="18" fill="#fbf3e7"/>
  <ellipse cx="17" cy="73" rx="7.5" ry="5.5" fill="#f3c79a"/>
  <ellipse cx="47" cy="73" rx="7.5" ry="5.5" fill="#f3c79a"/>
  <ellipse cx="26" cy="76" rx="5.5" ry="4.5" fill="#fbf3e7"/>
  <ellipse cx="38" cy="76" rx="5.5" ry="4.5" fill="#fbf3e7"/>
  <polygon points="13,17 21,1 31,15" fill="#d98441"/>
  <polygon points="51,17 43,1 33,15" fill="#d98441"/>
  <polygon points="16,15 21,5 27,14" fill="#f3b176"/>
  <polygon points="48,15 43,5 37,14" fill="#f3b176"/>
  <circle cx="32" cy="26" r="19" fill="#f0a35c"/>
  <ellipse cx="32" cy="31" rx="13" ry="10" fill="#fbf3e7"/>
  <ellipse cx="20.5" cy="30" rx="3" ry="1.8" fill="#f4a98f" opacity="0.6"/>
  <ellipse cx="43.5" cy="30" rx="3" ry="1.8" fill="#f4a98f" opacity="0.6"/>
  <circle cx="25" cy="25" r="3.1" fill="#3a2a1e"/>
  <circle cx="39" cy="25" r="3.1" fill="#3a2a1e"/>
  <circle cx="26" cy="24" r="0.9" fill="#fff"/>
  <circle cx="40" cy="24" r="0.9" fill="#fff"/>
  <ellipse cx="32" cy="29.5" rx="2.1" ry="1.5" fill="#3a2a1e"/>
  <path d="M32 31 q-3 3 -5 1.5 M32 31 q3 3 5 1.5" stroke="#7a5a3a" stroke-width="1" fill="none" stroke-linecap="round"/>
  <ellipse cx="32" cy="33.2" rx="2.1" ry="1.6" fill="#ef9aa0"/>
</svg>`;

// The mascot sprite. Drop your image at assets/mascot.png to use it everywhere;
// if it's missing or fails to load, the inline POM_SVG above is shown instead.
const MASCOT_IMG = '<img class="pom-img" src="assets/mascot.png" alt="Simba" />';

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
  document.querySelector(".brand-mark").innerHTML = MASCOT_IMG;

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
      btn.textContent = "Kopierat";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Kopiera"; btn.classList.remove("copied"); }, 1400);
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
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t && t.tagName === "IMG" && t.classList && t.classList.contains("pom-img")) {
      const span = document.createElement("span");
      span.className = "pom-fallback";
      span.innerHTML = POM_SVG;
      t.replaceWith(span);
    }
  }, true);

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
        out.note = `Visar de första ${cap.shownRows} av ${cap.totalRows} raderna (begränsat för storlek).`;
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
        out.note = `Visar de första ${cap.shownRows} av ${cap.totalRows} raderna (begränsat för storlek). Läs ett mindre område för allt.`;
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
    if (!is2DArray(values)) return { error: "values måste vara en icke-tom 2D-array (rader av kolumner)." };
    const ok = await gateEdit({ kind: "values", address, values });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.values = values;
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address };
    });
    toast(`Skrev ${result.address}`, "success");
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
    toast(`Angav formel i ${result.address}`, "success");
    return result;
  },

  async set_formulas({ address, formulas }) {
    if (!is2DArray(formulas)) return { error: "formulas måste vara en icke-tom 2D-array med formelsträngar." };
    const ok = await gateEdit({ kind: "values", address, values: formulas });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.formulas = formulas;
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address };
    });
    toast(`Angav formler i ${result.address}`, "success");
    return result;
  },

  async clear_range({ address, what = "contents" }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Rensa ${what} i ${address}` });
    if (!ok) return declined(ok);
    const map = { contents: "Contents", formats: "Formats", all: "All" };
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.clear(map[what] || "Contents");
      range.load("address");
      await ctx.sync();
      return { cleared: true, address: range.address, what };
    });
    toast(`Rensade ${result.address}`, "success");
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
    toast(`Formaterade ${result.address}`, "success");
    return result;
  },

  async insert_rows({ index, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Infoga ${count} rad(er) ovanför rad ${index}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(`${index}:${index + count - 1}`).insert("Down");
      await ctx.sync();
    });
    toast(`Infogade ${count} rad(er)`, "success");
    return { inserted: true, rows: count, at: index };
  },

  async delete_rows({ index, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Ta bort ${count} rad(er) från rad ${index}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      sheet.getRange(`${index}:${index + count - 1}`).delete("Up");
      await ctx.sync();
    });
    toast(`Tog bort ${count} rad(er)`, "success");
    return { deleted: true, rows: count, at: index };
  },

  async insert_columns({ column, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Infoga ${count} kolumn(er) före ${column}` });
    if (!ok) return declined(ok);
    const start = colIndex(column);
    const ref = `${colLetter(start)}:${colLetter(start + count - 1)}`;
    await Excel.run(async (ctx) => {
      ctx.workbook.worksheets.getActiveWorksheet().getRange(ref).insert("Right");
      await ctx.sync();
    });
    toast(`Infogade ${count} kolumn(er)`, "success");
    return { inserted: true, columns: count, before: column };
  },

  async delete_columns({ column, count = 1 }) {
    const ok = await gateEdit({ kind: "edit", summary: `Ta bort ${count} kolumn(er) från ${column}` });
    if (!ok) return declined(ok);
    const start = colIndex(column);
    const ref = `${colLetter(start)}:${colLetter(start + count - 1)}`;
    await Excel.run(async (ctx) => {
      ctx.workbook.worksheets.getActiveWorksheet().getRange(ref).delete("Left");
      await ctx.sync();
    });
    toast(`Tog bort ${count} kolumn(er)`, "success");
    return { deleted: true, columns: count, at: column };
  },

  async sort_range({ address, column_index = 0, ascending = true, has_headers = true }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Sortera ${address} efter kolumn ${column_index + 1} ${ascending ? "A→Z" : "Z→A"}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.sort.apply([{ key: column_index, ascending }], false, has_headers, "Rows");
      await ctx.sync();
    });
    toast(`Sorterade ${address}`, "success");
    return { sorted: true, address };
  },

  async autofit({ address }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Autopassa ${address}` });
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
    const ok = await gateEdit({ kind: "edit", address, summary: `Skapa en tabell från ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const table = sheet.tables.add(address, has_headers);
      if (name) table.name = name;
      table.load("name");
      await ctx.sync();
      return { created: true, table: table.name };
    });
    toast(`Skapade tabell ${result.table}`, "success");
    return result;
  },

  async create_chart({ data_range, chart_type = "ColumnClustered", title }) {
    const ok = await gateEdit({ kind: "edit", address: data_range, summary: `Skapa ett ${chart_type}-diagram från ${data_range}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const chart = sheet.charts.add(chart_type, parseRange(ctx, data_range), "Auto");
      if (title) chart.title.text = title;
      chart.load("name");
      await ctx.sync();
      return { created: true, chart: chart.name };
    });
    toast("Skapade diagram", "success");
    return result;
  },

  async add_sheet({ name }) {
    const ok = await gateEdit({ kind: "edit", summary: `Lägg till ett nytt blad${name ? ` med namnet "${name}"` : ""}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const ws = ctx.workbook.worksheets.add(name || undefined);
      ws.activate();
      ws.load("name");
      await ctx.sync();
      return { created: true, sheet: ws.name };
    });
    toast(`La till blad ${result.sheet}`, "success");
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
    ? { skipped: true, reason: "Du avböjde ändringen." }
    : { skipped: true, reason: "Redigering av arket är avstängd." };
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
  if (o.bold) bits.push("fet");
  if (o.italic) bits.push("kursiv");
  if (o.underline) bits.push("understruken");
  if (o.font_color) bits.push(`textfärg ${o.font_color}`);
  if (o.fill_color) bits.push(`fyllning ${o.fill_color}`);
  if (o.font_size) bits.push(`storlek ${o.font_size}`);
  if (o.align) bits.push(`justering ${o.align}`);
  if (o.wrap) bits.push("radbryt text");
  if (o.number_format) bits.push(`talformat "${o.number_format}"`);
  return `Formatera ${o.address}${bits.length ? ": " + bits.join(", ") : ""}`;
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
    selectionNote = `\n\n[Aktuell markering: ${sel.address} (${sel.rowCount}×${sel.columnCount})]`;
  } catch { /* no active selection */ }

  messages.push({ role: "user", content: text + selectionNote });
  renderMessage("user", text);

  setBusy(true);
  const typing = renderTyping();
  try {
    await runAgentLoop();
  } catch (err) {
    toast(err.message || "Något gick fel i kommunikationen med Simba.", "error", 4000);
  } finally {
    typing.remove();
    setBusy(false);
  }
}

async function runAgentLoop() {
  for (let i = 0; i < 12; i++) {
    const reply = await callBackend(messages);
    if (!reply || !Array.isArray(reply.content)) throw new Error("Simba returnerade ett oväntat svar.");
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
        result = fn ? await fn(use.input || {}) : { error: `Okänt verktyg ${use.name}` };
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
  renderMessage("assistant", "_(Stoppade efter för många steg. Försök att avgränsa förfrågan.)_");
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
        ? "Simba tog för lång tid på sig att svara. Försök igen."
        : "Kan inte nå Simba. Kontrollera din anslutning och att servern körs."
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let msg = `Simba serverfel (${res.status}).`;
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
      sub = "Simba vill ange en formel.";
      body = `${addrPill}<div class="preview-formula">${escapeHtml(details.formula)}</div>`;
    } else if (details.kind === "values") {
      sub = "Simba vill skriva till arket.";
      body = `${addrPill}${valuesPreviewTable(details.values)}`;
    } else {
      sub = "Simba vill redigera arket.";
      body = `${addrPill}<p class="confirm-summary">${escapeHtml(details.summary || "Tillämpa ändringen?")}</p>`;
    }

    openModal(
      `<h3>Tillämpa ändringen?</h3>
       <p class="sub">${sub}</p>
       ${body}
       <div class="modal-actions">
         <button class="btn" data-act="cancel">Avbryt</button>
         <button class="btn primary" data-act="apply">Tillämpa</button>
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
  if (!Array.isArray(values) || !values.length) return '<p class="sub">(tomt)</p>';
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
  if (values.length > maxR) html += `<p class="sub" style="margin-top:8px">+ ${values.length - maxR} rader till</p>`;
  return html;
}

function openSettings() {
  const theme = store.get("simba.theme", "auto");
  openModal(
    `<h3>Inställningar</h3>
     <div class="setting-row">
       <div><div class="label">Utseende</div><div class="hint">Följ systemet eller välj ett tema</div></div>
       <div class="seg" id="theme-seg">
         <button class="seg-btn ${theme === "auto" ? "active" : ""}" data-theme="auto">Auto</button>
         <button class="seg-btn ${theme === "light" ? "active" : ""}" data-theme="light">Ljust</button>
         <button class="seg-btn ${theme === "dark" ? "active" : ""}" data-theme="dark">Mörkt</button>
       </div>
     </div>
     <div class="setting-row">
       <div><div class="label">Modell</div><div class="hint">Drivs av Claude</div></div>
       <div class="setting-meta">${escapeHtml(modelName)}</div>
     </div>
     <div class="setting-row">
       <div><div class="label">Konversation</div><div class="hint">Rensa den aktuella chatten</div></div>
       <button class="btn" id="settings-clear" style="flex:none;padding:7px 12px">Ny chatt</button>
     </div>
     <div class="modal-actions">
       <button class="btn primary" data-act="done">Klar</button>
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
    <div class="avatar">${role === "user" ? "🙂" : MASCOT_IMG}</div>
    <div class="body"><div class="bubble">${formatMarkdown(text)}</div></div>`;
  els.messages.append(wrap);
  scrollDown();
}

function renderToolNote(name, input) {
  const labels = {
    get_selection: "Läser din markering",
    read_range: `Läser ${input?.address || "ett område"}`,
    get_sheet_info: "Granskar arket",
    list_sheets: "Tittar på arbetsboken",
    find: `Söker efter "${input?.query || ""}"`,
    write_range: `Skriver till ${input?.address || "ett område"}`,
    set_formula: `Anger en formel i ${input?.address || "ett område"}`,
    set_formulas: `Anger formler i ${input?.address || "ett område"}`,
    clear_range: `Rensar ${input?.address || "ett område"}`,
    format_range: `Formaterar ${input?.address || "ett område"}`,
    insert_rows: "Infogar rader",
    delete_rows: "Tar bort rader",
    insert_columns: "Infogar kolumner",
    delete_columns: "Tar bort kolumner",
    sort_range: `Sorterar ${input?.address || "ett område"}`,
    autofit: "Autopassar celler",
    create_table: `Skapar en tabell från ${input?.address || "ett område"}`,
    create_chart: "Skapar ett diagram",
    add_sheet: "Lägger till ett blad",
    select_range: `Markerar ${input?.address || "ett område"}`,
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
  el.innerHTML = `<div class="avatar">${MASCOT_IMG}</div><div class="body"><div class="bubble">
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
      `<button class="copy-btn" type="button">Kopiera</button></div>`;
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
    <span class="mchip active">Fråga</span>
    <span class="mchip">Auto</span>
    <span class="mchip">Av</span>
  </div>`;
}

function onbHelloArt() {
  return `<div class="onb-art art-hello">
    <span class="spark s1">✦</span><span class="spark s2">✦</span><span class="spark s3">✦</span>
    <div class="pom-tile">${MASCOT_IMG}</div>
  </div>`;
}

const ONB_STEPS = [
  {
    art: onbHelloArt,
    title: "Möt Simba",
    body: "Din AI-kompis i Excel — en nyfiken liten pomeranian som bor i ditt kalkylark och hjälper dig få jobbet gjort, snabbt.",
  },
  {
    art: onbGridArt,
    title: "Jag förstår din data",
    body: "Markera ett område och fråga på vanlig svenska. Jag läser dina celler, sammanfattar dem, hittar trender och svarar på frågor — utan att du behöver brottas med formler.",
  },
  {
    art: onbFormulaArt,
    title: "Och jag gör jobbet",
    body: "Be mig städa en kolumn, bygga en formel eller fylla i värden, så skriver jag dem direkt i arket — med en förhandsvisning så du ser exakt vad som ändras.",
  },
  {
    art: onbModesArt,
    title: "Du har alltid kontrollen",
    body: "Som standard <strong>frågar</strong> jag innan jag redigerar. Välj <strong>Auto</strong> för att låta mig tillämpa ändringar, eller <strong>Av</strong> för att bara läsa — när som helst, från fältet nedan.",
    cta: "Börja använda Simba",
  },
];

function showOnboarding() {
  if (document.querySelector(".onb-backdrop")) return;

  let step = 0;
  const bd = document.createElement("div");
  bd.className = "onb-backdrop";
  bd.innerHTML = `
    <div class="onb-modal" role="dialog" aria-modal="true" aria-label="Välkommen till Simba">
      <button class="onb-skip" type="button">Hoppa över</button>
      <div class="onb-stage"></div>
      <div class="onb-foot">
        <div class="onb-dots" role="tablist"></div>
        <div class="onb-nav">
          <button class="btn onb-back" type="button">Tillbaka</button>
          <button class="btn primary onb-next" type="button">Nästa</button>
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
    d.setAttribute("aria-label", `Steg ${i + 1}`);
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
    next.textContent = s.cta || "Nästa";
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
    toast("Tips: markera några celler och fråga sedan Simba om dem", "info", 3400);
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
  if (busy) { toast("Vänta lite — Simba arbetar fortfarande.", "info"); return; }
  messages = [];
  els.messages.innerHTML =
    '<div class="welcome"><h2>Ny chatt</h2><p>Vad vill du göra med ditt kalkylark?</p></div>';
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
    els.contextPill.textContent = `Markerat ${sel.address}`;
  } catch {
    els.contextPill.textContent = "Ingen markering";
  }
}
