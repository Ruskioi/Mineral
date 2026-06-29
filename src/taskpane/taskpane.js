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
let activeTyping = null; // the "thinking" dots; cleared once real content appears
let editMode = store.get("simba.editMode", "ask"); // auto | ask | off
let autoApproveTurn = false; // "Apply all" approves remaining edits for the current request
let speed = store.get("simba.speed", "balanced"); // fast | balanced | thorough

/* Per-user memory: short durable notes kept in localStorage and sent with each
 * request so Simba personalizes across chats. Stays on this device. */
const MEMORY_MAX = 50;
function memoryList() {
  try { return JSON.parse(store.get("simba.memory", "[]")) || []; } catch { return []; }
}
function memorySave(list) {
  store.set("simba.memory", JSON.stringify(list.slice(0, MEMORY_MAX)));
  pushMemory(); // sync up to the user's Microsoft account when signed in
}
function memoryAdd(note) {
  const text = String(note || "").trim();
  if (!text) return false;
  const list = memoryList();
  if (list.some((n) => n.toLowerCase() === text.toLowerCase())) return false;
  list.push(text);
  memorySave(list);
  return true;
}
function memoryClear() { memorySave([]); }
function mergeNotes(a, b) {
  const seen = new Set();
  const out = [];
  for (const n of [...(a || []), ...(b || [])]) {
    const t = String(n || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out.slice(0, MEMORY_MAX);
}

/* ---- Microsoft 365 sign-in + cross-device memory sync ------------------- *
 * When the server has SSO configured, we get an Office identity token, pull the
 * user's saved memory from the backend, and keep it in sync. Without SSO (or if
 * sign-in fails), memory stays on this device — no regression. */
let ssoServerConfigured = false;
let signedIn = false;
let userLabel = "";
let pushTimer = null;

async function getSsoToken() {
  try {
    if (typeof OfficeRuntime === "undefined" || !OfficeRuntime.auth?.getAccessToken) return null;
    return await OfficeRuntime.auth.getAccessToken({ allowSignInPrompt: true, allowConsentPrompt: true });
  } catch {
    return null; // not configured, user dismissed, or unsupported host
  }
}

async function initIdentity() {
  if (!ssoServerConfigured) return;
  const token = await getSsoToken();
  if (!token) return;
  try {
    const r = await fetch(`${API_BASE}/api/memory`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const data = await r.json();
    const serverNotes = Array.isArray(data.notes) ? data.notes : [];
    const merged = mergeNotes(memoryList(), serverNotes);
    signedIn = true;
    userLabel = (data.user && (data.user.name || data.user.email)) || "";
    store.set("simba.memory", JSON.stringify(merged)); // set without triggering a push yet
    if (merged.length !== serverNotes.length) pushMemory(); // local had extras → upload
  } catch { /* stay local */ }
}

function pushMemory() {
  if (!signedIn) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    const token = await getSsoToken();
    if (!token) return;
    try {
      await fetch(`${API_BASE}/api/memory`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes: memoryList() }),
      });
    } catch { /* best effort */ }
  }, 600);
}

function memoryStatusText() {
  if (signedIn) return `Synkas med ${userLabel || "ditt Microsoft-konto"} – följer dig på alla enheter.`;
  if (ssoServerConfigured) return "Microsoft-synk är på – öppna sidofältet igen om inget syns.";
  return "Sparas på den här enheten.";
}
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
  els.askDock = document.getElementById("ask-dock");

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
    const head = e.target.closest(".tg-head");
    if (head) {
      const card = head.closest(".tg-card");
      const open = card.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
      return;
    }
    const act = e.target.closest(".msg-act");
    if (act) {
      const msg = act.closest(".msg");
      if (act.dataset.act === "copy") {
        copyText((msg && msg._raw) || "").then(() => toast("Kopierat", "success", 1400));
      } else if (act.dataset.act === "regen" && !busy) {
        regenerate();
      }
      return;
    }
    const btn = e.target.closest(".copy-btn");
    if (!btn) return;
    const cb = btn.closest(".codeblock");
    const code = cb && cb.querySelector("code");
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

  // Pull the configured model name for the settings panel (best effort), then
  // sign the user in (if the server supports SSO) and sync their memory.
  fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((h) => {
    if (h?.model) modelName = h.model;
    ssoServerConfigured = !!h?.ssoConfigured;
    initIdentity();
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
      if (opts.column_width != null) f.columnWidth = opts.column_width;
      if (opts.border && opts.border !== "none") applyBorders(f, opts.border, opts.border_color);
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

  async set_column_width({ columns, width, autofit = false }) {
    const ok = await gateEdit({ kind: "edit", address: columns, summary: autofit ? `Autopassa bredd för ${columns}` : `Sätt kolumnbredd ${width} pt för ${columns}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, columns);
      if (autofit) range.format.autofitColumns();
      else if (width != null) range.format.columnWidth = width;
      range.load("address");
      await ctx.sync();
      return { sized: true, address: range.address, width: autofit ? "auto" : width };
    });
    toast(autofit ? `Autopassade ${columns}` : `Satte bredd ${width} pt`, "success");
    return result;
  },

  async set_row_height({ rows, height, autofit = false }) {
    const ok = await gateEdit({ kind: "edit", address: rows, summary: autofit ? `Autopassa höjd för ${rows}` : `Sätt radhöjd ${height} pt för ${rows}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, rows);
      if (autofit) range.format.autofitRows();
      else if (height != null) range.format.rowHeight = height;
      range.load("address");
      await ctx.sync();
      return { sized: true, address: range.address, height: autofit ? "auto" : height };
    });
    toast(autofit ? `Autopassade ${rows}` : `Satte höjd ${height} pt`, "success");
    return result;
  },

  async remember({ note }) {
    const text = String(note || "").trim();
    if (!text) return { error: "Tom anteckning." };
    const added = memoryAdd(text);
    if (!added) return { saved: false, reason: "Detta minns jag redan." };
    toast("Sparade i minnet", "success");
    return { saved: true, note: text };
  },

  async merge_cells({ address, across = false }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Sammanfoga ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.merge(!!across);
      range.load("address");
      await ctx.sync();
      return { merged: true, address: range.address };
    });
    toast(`Sammanfogade ${result.address}`, "success");
    return result;
  },

  async freeze_panes({ rows = 0, columns = 0 }) {
    const ok = await gateEdit({ kind: "edit", summary: rows || columns ? `Lås ${rows} rad(er) och ${columns} kolumn(er)` : "Lås upp rutor" });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      if (!rows && !columns) { sheet.freezePanes.unfreeze(); }
      else {
        // Freeze everything above and to the left of this top-left cell.
        const topLeft = `${colLetter(columns || 0)}${(rows || 0) + 1}`;
        sheet.freezePanes.freezeAt(sheet.getRange(topLeft));
      }
      await ctx.sync();
    });
    toast(rows || columns ? "Låste rutor" : "Låste upp rutor", "success");
    return { frozen: true, rows, columns };
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
  if (o.border && o.border !== "none") bits.push(`ram (${o.border})`);
  if (o.column_width != null) bits.push(`kolumnbredd ${o.column_width}`);
  if (o.number_format) bits.push(`talformat "${o.number_format}"`);
  return `Formatera ${o.address}${bits.length ? ": " + bits.join(", ") : ""}`;
}

/** Apply borders to a range format. kind: top | bottom | outline | all. */
function applyBorders(format, kind, color) {
  const c = color || "#BFBFBF";
  const set = (edge) => {
    const b = format.borders.getItem(edge);
    b.style = "Continuous";
    b.weight = "Thin";
    b.color = c;
  };
  if (kind === "top") set("EdgeTop");
  else if (kind === "bottom") set("EdgeBottom");
  else if (kind === "outline") ["EdgeTop", "EdgeBottom", "EdgeLeft", "EdgeRight"].forEach(set);
  else if (kind === "all") ["EdgeTop", "EdgeBottom", "EdgeLeft", "EdgeRight", "InsideVertical", "InsideHorizontal"].forEach(set);
}

/** Returns null (off), false (declined), or true (apply). */
async function gateEdit(details) {
  if (editMode === "off") return null;
  if (editMode === "auto" || autoApproveTurn) return true;
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

  autoApproveTurn = false; // each new request starts asking again
  setBusy(true);
  renderTyping();
  try {
    await runAgentLoop();
  } catch (err) {
    toast(err.message || "Något gick fel i kommunikationen med Simba.", "error", 4000);
  } finally {
    clearTyping();
    setBusy(false);
  }
}

async function regenerate() {
  if (busy) return;
  let idx = -1;
  for (let k = messages.length - 1; k >= 0; k--) {
    if (messages[k].role === "user" && typeof messages[k].content === "string") { idx = k; break; }
  }
  if (idx < 0) return;
  messages.length = idx + 1;                 // drop the last reply + any tool turns
  const users = els.messages.querySelectorAll(".msg.user");
  const lastUser = users[users.length - 1];
  if (lastUser) {
    let n = lastUser.nextElementSibling;
    while (n) { const nx = n.nextElementSibling; n.remove(); n = nx; }
  }
  autoApproveTurn = false;
  setBusy(true);
  renderTyping();
  try {
    await runAgentLoop();
  } catch (err) {
    toast(err.message || "Något gick fel i kommunikationen med Simba.", "error", 4000);
  } finally {
    clearTyping();
    setBusy(false);
  }
}

async function runAgentLoop() {
  let group = null; // collapsible activity card for this turn's tool steps
  for (let i = 0; i < 12; i++) {
    const reply = await callBackend(messages);
    if (!reply || !Array.isArray(reply.content)) throw new Error("Simba returnerade ett oväntat svar.");
    messages.push({ role: "assistant", content: reply.content });

    for (const b of reply.content) {
      if (b.type === "text" && b.text.trim()) {
        if (group) { finalizeToolGroup(group); group = null; } // close the activity card before the reply
        renderMessage("assistant", b.text);
      }
    }

    if (reply.stop_reason !== "tool_use") { finalizeToolGroup(group); return; }

    const toolUses = reply.content.filter((b) => b.type === "tool_use");
    const results = [];
    for (const use of toolUses) {
      if (!group) group = createToolGroup();
      const step = groupAddStep(group, use.name, use.input);
      let result, isError = false;
      try {
        const fn = tools[use.name];
        result = fn ? await fn(use.input || {}) : { error: `Okänt verktyg ${use.name}` };
      } catch (e) {
        result = { error: e.message || String(e) };
        isError = true;
      }
      if (result && result.error) isError = true;
      markStepDone(group, step, isError);
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: JSON.stringify(result),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: results });
  }
  finalizeToolGroup(group);
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
      body: JSON.stringify({ messages: history, speed, memory: memoryList() }),
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

/** Slides a small confirmation box up above the input; resolves true/false. */
function confirmEdit(details) {
  return new Promise((resolve) => {
    const dock = els.askDock;
    let settled = false;

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

    const card = document.createElement("div");
    card.className = "ask-card";
    card.innerHTML =
      `<div class="ask-head"><span class="ask-ic" aria-hidden="true">✦</span><span class="ask-sub">${sub}</span></div>
       <div class="ask-body">${body}</div>
       <div class="ask-actions">
         <button class="btn" type="button" data-act="cancel">Avbryt</button>
         <button class="btn ghost" type="button" data-act="all" title="Godkänn alla ändringar i den här förfrågan">Tillämpa alla</button>
         <button class="btn primary" type="button" data-act="apply">Tillämpa</button>
       </div>
       <p class="ask-hint">Enter för att tillämpa · Esc för att avbryta</p>`;

    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); finish("all"); }
      else if (e.key === "Enter") { e.preventDefault(); finish(true); }
    };
    function finish(v) {
      if (settled) return;
      settled = true;
      if (v === "all") autoApproveTurn = true; // skip prompts for the rest of this request
      document.removeEventListener("keydown", onKey);
      card.classList.add("leaving");
      card.addEventListener("animationend", () => card.remove(), { once: true });
      setTimeout(() => card.remove(), 260);
      resolve(v === "all" ? true : v);
    }

    dock.innerHTML = "";            // one question at a time
    dock.appendChild(card);
    card.querySelector('[data-act="apply"]').onclick = () => finish(true);
    card.querySelector('[data-act="all"]').onclick = () => finish("all");
    card.querySelector('[data-act="cancel"]').onclick = () => finish(false);
    document.addEventListener("keydown", onKey);
    setTimeout(() => card.querySelector('[data-act="apply"]').focus(), 30);
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
       <div><div class="label">Svarshastighet</div><div class="hint">Snabbare svar eller mer noggrann analys</div></div>
       <div class="seg" id="speed-seg">
         <button class="seg-btn ${speed === "fast" ? "active" : ""}" data-speed="fast" title="Snabbast – använder snabbläge">Snabb</button>
         <button class="seg-btn ${speed === "balanced" ? "active" : ""}" data-speed="balanced" title="Bra balans mellan fart och kvalitet">Balanserad</button>
         <button class="seg-btn ${speed === "thorough" ? "active" : ""}" data-speed="thorough" title="Mest noggrann – tar längre tid">Noggrann</button>
       </div>
     </div>
     <div class="setting-row">
       <div><div class="label">Modell</div><div class="hint">Drivs av Claude</div></div>
       <div class="setting-meta">${escapeHtml(modelName)}</div>
     </div>
     <div class="setting-row" style="align-items:flex-start">
       <div><div class="label">Minne</div><div class="hint">Vad Simba minns om dig – en rad per sak. ${escapeHtml(memoryStatusText())}</div></div>
       <button class="btn" id="memory-clear" style="flex:none;padding:7px 12px">Rensa</button>
     </div>
     <textarea id="memory-text" class="memory-text" rows="4" placeholder="Inget sparat än. Be Simba att minnas något, eller skriv här – en rad per sak.">${escapeHtml(memoryList().join("\n"))}</textarea>
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
  els.modalCard.querySelector("#speed-seg").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    speed = b.dataset.speed;
    store.set("simba.speed", speed);
    els.modalCard.querySelectorAll("#speed-seg .seg-btn")
      .forEach((x) => x.classList.toggle("active", x === b));
  });
  const memoryTextEl = els.modalCard.querySelector("#memory-text");
  const saveMemoryFromText = () => {
    const list = memoryTextEl.value.split("\n").map((s) => s.trim()).filter(Boolean);
    memorySave(list);
  };
  els.modalCard.querySelector("#memory-clear").onclick = () => { memoryTextEl.value = ""; memoryClear(); };
  els.modalCard.querySelector("#settings-clear").onclick = () => { resetChat(); closeModalSilently(); };
  els.modalCard.querySelector('[data-act="done"]').onclick = () => { saveMemoryFromText(); closeModalSilently(); };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderMessage(role, text) {
  clearTyping();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap._raw = text;
  const actions = role === "assistant"
    ? `<div class="msg-actions">` +
      `<button class="msg-act" data-act="copy" type="button" title="Kopiera svar" aria-label="Kopiera svar">⧉</button>` +
      `<button class="msg-act" data-act="regen" type="button" title="Generera om" aria-label="Generera om">↻</button>` +
      `</div>`
    : "";
  wrap.innerHTML = `
    <div class="avatar">${role === "user" ? "🙂" : MASCOT_IMG}</div>
    <div class="body"><div class="bubble">${formatMarkdown(text)}</div>${actions}</div>`;
  els.messages.append(wrap);
  scrollDown();
}

function toolLabel(name, input) {
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
    set_column_width: input?.autofit ? "Autopassar kolumnbredd" : `Ändrar kolumnbredd för ${input?.columns || "kolumner"}`,
    set_row_height: input?.autofit ? "Autopassar radhöjd" : `Ändrar radhöjd för ${input?.rows || "rader"}`,
    merge_cells: `Sammanfogar ${input?.address || "celler"}`,
    freeze_panes: "Låser rutor",
    remember: "Sparar i minnet",
    create_table: `Skapar en tabell från ${input?.address || "ett område"}`,
    create_chart: "Skapar ett diagram",
    add_sheet: "Lägger till ett blad",
    select_range: `Markerar ${input?.address || "ett område"}`,
  };
  return labels[name] || name;
}

/* A single collapsible "activity" card that groups all of Simba's tool steps for
 * one turn, instead of stacking a separate message per step. Expanded while it
 * runs; collapses to a tidy summary when done (still clickable to re-open). */
function createToolGroup() {
  clearTyping();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant tool-group";
  wrap.innerHTML = `
    <div class="avatar">${MASCOT_IMG}</div>
    <div class="body">
      <div class="tg-card open">
        <button class="tg-head" type="button" aria-expanded="true">
          <span class="tg-ic"><span class="spinner"></span></span>
          <span class="tg-title">Arbetar…</span>
          <span class="tg-count" hidden>0</span>
          <span class="tg-chev" aria-hidden="true">›</span>
        </button>
        <div class="tg-body"><div class="tg-steps"></div></div>
      </div>`;
  els.messages.append(wrap);
  const group = {
    card: wrap.querySelector(".tg-card"),
    titleEl: wrap.querySelector(".tg-title"),
    countEl: wrap.querySelector(".tg-count"),
    icEl: wrap.querySelector(".tg-ic"),
    stepsEl: wrap.querySelector(".tg-steps"),
    count: 0,
    done: 0,
  };
  scrollDown();
  return group;
}

function groupAddStep(group, name, input) {
  group.count++;
  const step = document.createElement("div");
  step.className = "tg-step running";
  step.innerHTML = `<span class="tg-step-ic"><span class="spinner sm"></span></span>` +
    `<span class="tg-step-lbl">${escapeHtml(toolLabel(name, input))}</span>`;
  group.stepsEl.append(step);
  group.titleEl.textContent = toolLabel(name, input);
  scrollDown();
  return step;
}

function markStepDone(group, step, isError) {
  step.classList.remove("running");
  step.classList.add(isError ? "error" : "done");
  step.querySelector(".tg-step-ic").textContent = isError ? "!" : "✓";
  group.done++;
}

function finalizeToolGroup(group) {
  if (!group) return;
  const n = group.count;
  group.titleEl.textContent = n === 1 ? "1 åtgärd utförd" : `${n} åtgärder utförda`;
  group.countEl.textContent = String(n);
  group.countEl.hidden = false;
  group.icEl.innerHTML = '<span class="tg-check">✓</span>';
  group.card.classList.remove("open");           // collapse to a tidy summary
  group.card.querySelector(".tg-head")?.setAttribute("aria-expanded", "false");
}

function renderTyping() {
  clearTyping();
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="avatar">${MASCOT_IMG}</div><div class="body"><div class="bubble">
    <span class="typing"><span></span><span></span><span></span></span></div></div>`;
  els.messages.append(el);
  activeTyping = el;
  scrollDown();
  return el;
}

function clearTyping() {
  if (activeTyping) { activeTyping.remove(); activeTyping = null; }
}

/** Markdown: fenced code (with header), headings, lists, links, quotes, hr, inline. */
function formatMarkdown(text) {
  const blocks = [];
  const src = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const label = (lang || "").toLowerCase();
    const html =
      `<div class="codeblock">` +
        `<div class="cb-head"><span class="cb-lang">${escapeHtml(label || "kod")}</span>` +
        `<button class="copy-btn" type="button">Kopiera</button></div>` +
        `<pre><code>${highlight(code.replace(/\n+$/, ""), lang)}</code></pre>` +
      `</div>`;
    blocks.push(html);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  const inline = (s) => s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const lines = escapeHtml(src).split("\n");
  const isPH = (l) => /^\u0000\d+\u0000$/.test(l.trim());
  let out = "", i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isPH(line)) { out += line.trim(); i++; continue; }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { out += "<hr>"; i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1])) {
      const splitRow = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
      const body = rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] || "")}</td>`).join("")}</tr>`).join("");
      out += `<div class="md-tablewrap"><table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
      continue;
    }
    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) { const lv = Math.min(h[1].length + 2, 6); out += `<h${lv} class="md-h">${inline(h[2])}</h${lv}>`; i++; continue; }
    if (/^\s*&gt;\s?/.test(line)) {
      const it = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { it.push(inline(lines[i].replace(/^\s*&gt;\s?/, ""))); i++; }
      out += `<blockquote>${it.join("<br>")}</blockquote>`; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const it = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { it.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`); i++; }
      out += `<ul>${it.join("")}</ul>`; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const it = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { it.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; }
      out += `<ol>${it.join("")}</ol>`; continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" && !isPH(lines[i]) &&
           !/^\s*(#{1,4}\s|[-*]\s|\d+\.\s|&gt;\s?|---\s*$|\*\*\*\s*$|___\s*$)/.test(lines[i])) {
      para.push(lines[i]); i++;
    }
    out += `<p>${inline(para.join("<br>"))}</p>`;
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, n) => blocks[+n]);
}

/* ------------------------------------------------------------------ *
 * Lightweight syntax highlighting (no dependency), language-aware.
 * Tuned per language: Excel formulas, JS/TS, Python, SQL, Bash, JSON,
 * CSS, and HTML/XML — each with the right comments and keyword set.
 * ------------------------------------------------------------------ */

const LANG_KW = {
  js: "const let var function return if else for while do switch case break continue class new import from export default async await try catch finally throw typeof instanceof in of yield delete void this super extends static get set",
  ts: "const let var function return if else for while do switch case break continue class new import from export default async await try catch finally throw typeof instanceof in of yield delete void this super extends static get set interface type enum implements namespace declare readonly public private protected abstract as keyof infer",
  python: "def class return if elif else for while try except finally raise import from as with lambda yield pass break continue global nonlocal assert del in is not and or async await match case print self",
  sql: "select from where group by order having insert update delete into values set join inner left right outer full cross on as create table view drop alter add column primary key foreign references distinct limit offset union all and or not is like between case when then else end desc asc count sum avg min max",
  bash: "if then else elif fi for while until do done case esac function in return export local readonly declare unset source echo cd",
  json: "",
  css: "",
};
const CONST_WORDS = new Set("true false null undefined none None TRUE FALSE NULL nil NaN Infinity".split(" "));

const COMMENTS = {
  js: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y,
  ts: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y,
  css: /\/\*[\s\S]*?\*\//y,
  python: /#[^\n]*/y,
  bash: /#[^\n]*/y,
  sql: /--[^\n]*|\/\*[\s\S]*?\*\//y,
  json: null,
};

const STR_RULE = { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/y, cls: "tok-str" };
const NUM_RULE = { re: /\b\d[\d_]*(?:\.\d+)?\b/y, cls: "tok-num" };
const FUNC_RULE = { re: /[A-Za-z_$][\w$]*(?=\s*\()/y, cls: "tok-func" };

const FORMULA_RULES = [
  { re: /"(?:[^"]|"")*"/y, cls: "tok-str" },
  { re: /\b[A-Z][A-Z0-9_.]*(?=\s*\()/y, cls: "tok-func" },
  { re: /\b(?:TRUE|FALSE)\b/y, cls: "tok-bool" },
  { re: /\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?\b/y, cls: "tok-ref" },
  { re: /\d+(?:\.\d+)?/y, cls: "tok-num" },
  { re: /[-+*/^&=<>%]/y, cls: "tok-op" },
];

const MARKUP_RULES = [
  { re: /<!--[\s\S]*?-->/y, cls: "tok-com" },
  { re: /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y, cls: "tok-str" },
  { re: /<\/?[A-Za-z][\w:-]*|\/?>/y, cls: "tok-func" },
  { re: /[A-Za-z_:][\w:-]*(?==)/y, cls: "tok-kw" },
];

function normLang(lang, code) {
  const l = (lang || "").toLowerCase();
  if (["excel", "formula", "xls", "xlsx"].includes(l)) return "formula";
  if (["js", "javascript", "jsx", "mjs", "cjs", "node"].includes(l)) return "js";
  if (["ts", "typescript", "tsx"].includes(l)) return "ts";
  if (["py", "python"].includes(l)) return "python";
  if (["sql", "mysql", "postgres", "postgresql", "psql", "sqlite"].includes(l)) return "sql";
  if (["sh", "bash", "shell", "zsh", "console"].includes(l)) return "bash";
  if (["json", "jsonc"].includes(l)) return "json";
  if (["css", "scss", "less"].includes(l)) return "css";
  if (["html", "xml", "xhtml", "svg", "markup"].includes(l)) return "markup";
  if (!l && code && code.trim().startsWith("=")) return "formula";
  return "js"; // sensible default for unlabeled / unknown code
}

function rulesFor(lang) {
  const kw = new Set((LANG_KW[lang] || LANG_KW.js).split(/\s+/).filter(Boolean));
  const rules = [];
  const com = COMMENTS[lang];
  if (com) rules.push({ re: com, cls: "tok-com" });
  rules.push(STR_RULE, NUM_RULE, FUNC_RULE);
  rules.push({
    re: /[A-Za-z_$][\w$]*/y,
    fn: (t) => (CONST_WORDS.has(t) ? "tok-bool" : kw.has(t) || kw.has(t.toLowerCase()) ? "tok-kw" : null),
  });
  return rules;
}

function highlight(code, lang) {
  const l = normLang(lang, code);
  if (l === "formula") return tokenize(code, FORMULA_RULES);
  if (l === "markup") return tokenize(code, MARKUP_RULES);
  return tokenize(code, rulesFor(l));
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
