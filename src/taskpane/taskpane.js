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
let pendingAttachments = []; // [{name, kind, block}] user-attached files for the next message
const MAX_ATTACH = 6;
let activeAgent = null; // a selected specialist agent persona for the next message(s)
let IS_EXCEL = false; // true only when running inside Excel (Office.js available)
let IS_OUTLOOK = false; // true when running inside Outlook (mailbox item available)
// Tools that only make sense inside Outlook (read the open message via Office.js).
const OUTLOOK_TOOLS = new Set(["read_current_email"]);
// Whether a tool may run on the current surface.
function toolAllowed(name) {
  if (IS_EXCEL) return true;                                  // Excel: all tools
  if (typeof DESKTOP_TOOLS !== "undefined" && DESKTOP_TOOLS.has(name)) return true; // shared tools
  if (IS_OUTLOOK && OUTLOOK_TOOLS.has(name)) return true;     // Outlook-only tools
  return false;
}

// Specialist agents (à la Claude Code / Cowork / Design): each is a focused
// persona that steers Simba's tools toward one kind of work. Selecting one runs
// the conversation with its directive until you switch it off.
const AGENTS = [
  { id: "analyst", icon: "📊", name: "Analytiker", blurb: "Djup dataanalys, kör kod, hittar insikter.",
    directive: "[Agent: Analytiker] Du är en noggrann dataanalytiker. Använd run_code och analyze_data för EXAKTA beräkningar i stället för att uppskatta. Hitta trender, avvikelser och samband, och presentera tydliga slutsatser med konkreta siffror. Läs relevant data först." },
  { id: "builder", icon: "🧱", name: "Modellbyggare", blurb: "Bygger ark, modeller och dashboards.",
    directive: "[Agent: Modellbyggare] Du bygger välstrukturerade kalkylark, modeller och dashboards. Planera layouten, använd riktiga formler, snygg formatering och diagram. Föreslå en kort plan (propose_plan) för stora byggen innan du kör, och dela vid behov upp jobbet med delegate_task." },
  { id: "researcher", icon: "🔎", name: "Researcher", blurb: "Webbresearch med källor.",
    directive: "[Agent: Researcher] Du gör webbresearch. Använd web_lookup för aktuella fakta, sammanfatta kortfattat, och ange alltid källor. Ge konkreta svar användaren kan agera på." },
  { id: "designer", icon: "📝", name: "Dokument", blurb: "Skapar polerade dokument & presentationer.",
    directive: "[Agent: Dokument] Du skapar polerade dokument och presentationer med create_document (Word/PowerPoint/Excel/PDF). Strukturera innehållet professionellt; gör rimliga antaganden om syfte och målgrupp om de inte angetts." },
  { id: "reviewer", icon: "✅", name: "Granskare", blurb: "Granskar arket för fel & kvalitet.",
    directive: "[Agent: Granskare] Du granskar arbetsboken kritiskt. Hitta formelfel (find_errors), inkonsekvenser och kvalitetsbrister, spåra beroenden (trace_cell) vid behov, och rapportera fynden med konkreta förslag på åtgärder." },
  { id: "automator", icon: "⏰", name: "Automatiserare", blurb: "Sätter upp återkommande jobb.",
    directive: "[Agent: Automatiserare] Du hjälper användaren automatisera arbete: sätt upp återkommande jobb med schedule_task (bekräfta schema och målfil först) eller orkestrera deluppgifter med delegate_task." },
];
// Tools that work in the standalone desktop app (no Excel grid). Everything else
// requires Office.js and is short-circuited with a friendly message in desktop mode.
const DESKTOP_TOOLS = new Set(["remember", "search_vault", "save_to_vault", "analyze_vault", "open_vault_file", "save_to_workspace", "get_workspace", "list_data_sources", "query_data_source", "web_lookup", "run_code", "list_files", "open_file", "list_emails", "read_email", "send_email", "create_document", "propose_plan", "delegate_task", "schedule_task", "list_schedules", "cancel_schedule"]);
let editMode = store.get("simba.editMode", "ask"); // auto | ask | off
let autoApproveTurn = false; // "Apply all" approves remaining edits for the current request
let subagentDepth = 0;       // guards delegate_task against runaway recursion
let stopRequested = false;   // set by the Stop button to bail out of the agent loop
let activeController = null;  // AbortController for the in-flight /api/chat request
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

// Silent by default: only show Office's sign-in/consent dialog when the user
// explicitly asks (interactive = true), so opening the pane never pops a prompt.
async function getSsoToken(interactive = false) {
  try {
    if (typeof OfficeRuntime === "undefined" || !OfficeRuntime.auth?.getAccessToken) return null;
    return await OfficeRuntime.auth.getAccessToken({
      allowSignInPrompt: interactive,
      allowConsentPrompt: interactive,
    });
  } catch {
    return null; // not configured, not signed in, user dismissed, or unsupported host
  }
}

async function initIdentity(interactive = false) {
  if (!ssoServerConfigured) return false;
  const token = await getSsoToken(interactive);
  if (!token) return false;
  try {
    const r = await fetch(`${API_BASE}/api/memory`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const data = await r.json();
    const serverNotes = Array.isArray(data.notes) ? data.notes : [];
    const merged = mergeNotes(memoryList(), serverNotes);
    signedIn = true;
    userLabel = (data.user && (data.user.name || data.user.email)) || "";
    store.set("simba.memory", JSON.stringify(merged)); // set without triggering a push yet
    if (merged.length !== serverNotes.length) pushMemory(); // local had extras → upload
    loadConversations(); // resume the user's most recent chat across devices
    return true;
  } catch { return false; } // stay local
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
// Simba — a fluffy Pomeranian head, drawn in vector so it stays crisp at every
// size (16px ribbon icon → splash). Built from layered solid shapes only (no
// shared gradient IDs) so it renders correctly even when many copies are added
// and removed from the chat.
const POM_SVG = `
<svg viewBox="0 0 80 80" aria-hidden="true" focusable="false">
  <g fill="#dd854b">
    <circle cx="40" cy="13" r="9"/><circle cx="55" cy="16" r="9"/><circle cx="65" cy="27" r="9"/>
    <circle cx="68" cy="41" r="9"/><circle cx="64" cy="55" r="9"/><circle cx="54" cy="64" r="9"/>
    <circle cx="40" cy="68" r="9"/><circle cx="26" cy="64" r="9"/><circle cx="16" cy="55" r="9"/>
    <circle cx="12" cy="41" r="9"/><circle cx="15" cy="27" r="9"/><circle cx="25" cy="16" r="9"/>
  </g>
  <g fill="#efa863">
    <circle cx="40" cy="18" r="8"/><circle cx="52" cy="21" r="8"/><circle cx="60" cy="30" r="8"/>
    <circle cx="62" cy="42" r="8"/><circle cx="58" cy="53" r="8"/><circle cx="49" cy="60" r="8"/>
    <circle cx="40" cy="62" r="8"/><circle cx="31" cy="60" r="8"/><circle cx="22" cy="53" r="8"/>
    <circle cx="18" cy="42" r="8"/><circle cx="20" cy="30" r="8"/><circle cx="28" cy="21" r="8"/>
  </g>
  <path d="M18 22 L24 6 L34 18 Z" fill="#cf7a42"/>
  <path d="M62 22 L56 6 L46 18 Z" fill="#cf7a42"/>
  <path d="M21 20 L24 10 L31 18 Z" fill="#f1bd8b"/>
  <path d="M59 20 L56 10 L49 18 Z" fill="#f1bd8b"/>
  <circle cx="40" cy="40" r="22" fill="#f6c891"/>
  <ellipse cx="40" cy="44" rx="17" ry="16" fill="#fdf4e7"/>
  <ellipse cx="25" cy="44" rx="4" ry="2.6" fill="#f3a39c" opacity=".55"/>
  <ellipse cx="55" cy="44" rx="4" ry="2.6" fill="#f3a39c" opacity=".55"/>
  <path d="M27 32 q4 -2.5 8 -0.5" stroke="#cf7a42" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".55"/>
  <path d="M45 31.5 q4 -2 8 0.5" stroke="#cf7a42" stroke-width="1.4" fill="none" stroke-linecap="round" opacity=".55"/>
  <ellipse cx="31" cy="38" rx="4.2" ry="4.8" fill="#3a2a1e"/>
  <ellipse cx="49" cy="38" rx="4.2" ry="4.8" fill="#3a2a1e"/>
  <circle cx="32.6" cy="36.2" r="1.5" fill="#fff"/>
  <circle cx="50.6" cy="36.2" r="1.5" fill="#fff"/>
  <circle cx="29.8" cy="39.6" r="0.7" fill="#fff" opacity=".7"/>
  <circle cx="47.8" cy="39.6" r="0.7" fill="#fff" opacity=".7"/>
  <path d="M36.5 46 q3.5 3 7 0 q-1 3.1 -3.5 3.1 q-2.5 0 -3.5 -3.1 Z" fill="#41312a"/>
  <ellipse cx="38.2" cy="46.4" rx="0.8" ry="0.5" fill="#fff" opacity=".5"/>
  <path d="M40 49 v2.2" stroke="#7a5a3a" stroke-width="1" stroke-linecap="round"/>
  <path d="M40 51.2 q-3 3 -6 1.2 M40 51.2 q3 3 6 1.2" stroke="#7a5a3a" stroke-width="1.1" fill="none" stroke-linecap="round"/>
</svg>`;

// The mascot sprite — the inline vector above, used everywhere so it stays sharp.
const MASCOT_IMG = POM_SVG;

// Avatar for assistant output: the active specialist agent's icon while one is
// running (so each agent appears as its own sub-agent), else Simba's mascot.
function currentAvatar() {
  return activeAgent ? `<span class="agent-emoji" title="${escapeHtml(activeAgent.name)}-agent">${activeAgent.icon}</span>` : MASCOT_IMG;
}

let booted = false;
function boot(isExcel) {
  if (booted) return;
  booted = true;
  IS_EXCEL = isExcel;

  els.messages = document.getElementById("messages");
  els.prompt = document.getElementById("prompt");
  els.send = document.getElementById("send");
  els.newChat = document.getElementById("new-chat");
  els.settings = document.getElementById("settings");
  els.undo = document.getElementById("undo");
  els.attach = document.getElementById("attach");
  els.fileInput = document.getElementById("file-input");
  els.attachChip = document.getElementById("attach-chip");
  els.contextPill = document.getElementById("context-pill");
  els.editMode = document.getElementById("edit-mode");
  els.overlay = document.getElementById("modal-overlay");
  els.modalCard = document.getElementById("modal-card");
  els.toasts = document.getElementById("toast-container");
  els.askDock = document.getElementById("ask-dock");

  applyTheme(store.get("simba.theme", "auto"));
  syncEditModeButtons();
  document.querySelector(".brand-mark").innerHTML = MASCOT_IMG;
  const wm = document.getElementById("chat-watermark"); // faint grey mascot behind the chat
  if (wm) wm.innerHTML = MASCOT_IMG;

  els.send.addEventListener("click", () => { if (busy) stopGeneration(); else onSend(); });
  els.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
  });
  els.prompt.addEventListener("input", autoGrow);
  els.newChat.addEventListener("click", resetChat);
  els.settings.addEventListener("click", openSettings);
  els.undo.addEventListener("click", () => { if (!busy) tools.revert_last_change(); });
  els.attach.addEventListener("click", () => els.fileInput.click());
  els.cloud = document.getElementById("cloud");
  els.cloud?.addEventListener("click", openFilesBrowser);
  els.agents = document.getElementById("agents");
  els.agentChip = document.getElementById("agent-chip");
  els.agents?.addEventListener("click", openAgents);
  els.vault = document.getElementById("vault");
  els.vault?.addEventListener("click", openVault);
  els.mail = document.getElementById("mail");
  els.mail?.addEventListener("click", openMail);
  els.connectors = document.getElementById("connectors");
  els.connectors?.addEventListener("click", openConnectors);
  els.fileInput.addEventListener("change", (e) => { for (const f of e.target.files || []) handleAttach(f); e.target.value = ""; });

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
    const pv = e.target.closest(".preview-btn");
    if (pv) {
      try { openArtifact(decodeURIComponent(escape(atob(pv.dataset.code || "")))); } catch { /* ignore */ }
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
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); openCommandPalette(); }
  });

  bindSuggestions();

  window.addEventListener("unhandledrejection", (e) => console.error("[Simba] unhandled rejection:", e.reason));
  window.addEventListener("error", (e) => console.error("[Simba] error:", e.message));

  if (IS_EXCEL) {
    if (els.messages.querySelector(".welcome")) { els.messages.innerHTML = welcomeHTML(); bindSuggestions(); }
    refreshContextPill();
    Excel.run(async (ctx) => {
      ctx.workbook.worksheets.onSelectionChanged?.add?.(refreshContextPill);
      await ctx.sync();
    }).catch(() => {});
  } else {
    applyDesktopMode();
  }

  // Pull the configured model name for the settings panel (best effort), then
  // sign the user in (if the server supports SSO) and sync their memory.
  fetch(`${API_BASE}/api/health`).then((r) => r.json()).then((h) => {
    if (h?.model) modelName = h.model;
    ssoServerConfigured = !!h?.ssoConfigured;
    if (ssoServerConfigured && els.cloud) els.cloud.hidden = false; // cloud files need SSO
    if (ssoServerConfigured && els.vault) els.vault.hidden = false; // vault is org-scoped (SSO)
    if (ssoServerConfigured && els.mail) els.mail.hidden = false; // Outlook mail needs SSO/Graph
    if (ssoServerConfigured && els.connectors) els.connectors.hidden = false; // data sources are org-scoped (SSO)
    initIdentity();
  }).catch(() => {});

  hideSplash();

  // One-time onboarding tip on first open.
  if (!store.get("simba.onboarded", "")) setTimeout(showOnboarding, 450);
}

// Boot inside Excel via Office.onReady; otherwise (Electron/desktop or a plain
// browser) boot in desktop mode. The timeout is a fallback if Office never readies.
if (typeof Office !== "undefined" && Office.onReady) {
  Office.onReady((info) => {
    const host = info && info.host;
    IS_OUTLOOK = host === Office.HostType.Outlook;
    boot(host === Office.HostType.Excel);
  });
} else {
  boot(false);
}
setTimeout(() => boot(false), 4000);

function applyDesktopMode() {
  document.body.classList.add("desktop");          // CSS hides Excel-only chrome
  if (els.prompt) els.prompt.placeholder = "Fråga Simba vad som helst…";
  const w = document.querySelector(".welcome");
  if (w) w.innerHTML = desktopWelcomeHTML();
  bindSuggestions();
  // Reveal and wire the persistent conversation sidebar (the Claude-app layout).
  const sb = document.getElementById("sidebar");
  if (sb) {
    sb.hidden = false;
    document.getElementById("sb-new")?.addEventListener("click", () => { resetChat(); refreshSidebar(); });
    document.getElementById("sb-settings")?.addEventListener("click", openSettings);
    refreshSidebar();
  }
  // PWA: register the service worker so the web app is installable + offline-resilient.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("/sw.js").catch(() => { /* non-fatal */ });
  }
}

// A polished empty state: a mascot badge in a soft halo, a warm greeting, and
// suggestion chips with leading icons. Surface-aware copy/suggestions.
function suggestionChip(icon, text) {
  return `<button class="suggestion" data-prompt="${escapeHtml(text)}"><span class="sg-ic" aria-hidden="true">${icon}</span><span class="sg-tx">${escapeHtml(text)}</span></button>`;
}
function heroWelcome(title, sub, items) {
  return (
    `<div class="welcome-hero">` +
      `<div class="welcome-badge"><span class="welcome-halo"></span>${MASCOT_IMG}</div>` +
      `<h2>${escapeHtml(title)}</h2>` +
      `<p>${escapeHtml(sub)}</p>` +
    `</div>` +
    `<div class="suggestions">${items.map(([ic, tx]) => suggestionChip(ic, tx)).join("")}</div>`
  );
}
function desktopWelcomeHTML() {
  return heroWelcome(
    "Hej, jag är Simba",
    "Din AI-assistent för precis allt — fråga, research, analys, kod, dokument och dina filer.",
    [
      ["💡", "Förklara ett krångligt ämne enkelt"],
      ["📰", "Sök upp och sammanfatta de senaste nyheterna"],
      ["📎", "Analysera en fil jag bifogar"],
      ["📊", "Skapa en PowerPoint från mina anteckningar"],
    ]
  );
}
function welcomeHTML() {
  const inner = !IS_EXCEL
    ? desktopWelcomeHTML()
    : heroWelcome(
        "Hej, jag är Simba",
        "Din assistent i Excel — bygg, städa, analysera och förklara ditt ark.",
        [
          ["🧾", "Sammanfatta arbetsboken"],
          ["📐", "Bygg en budget med summor och diagram"],
          ["🔍", "Hitta och förklara formelfel"],
        ]
      );
  return `<div class="welcome">${inner}</div>`;
}

function bindSuggestions() {
  document.querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => { els.prompt.value = b.dataset.prompt || b.textContent; onSend(); }));
}

function hideSplash() {
  const s = document.getElementById("splash");
  if (!s) return;
  s.classList.add("hide");
  setTimeout(() => s.remove(), 500);
}

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

  async describe_workbook() {
    return Excel.run(async (ctx) => {
      const wsCol = ctx.workbook.worksheets;
      wsCol.load("items/name,items/position,items/visibility");
      const names = ctx.workbook.names;
      names.load("items/name,items/type,items/formula,items/visible");
      await ctx.sync();

      const sheets = wsCol.items;
      const useds = sheets.map((s) => s.getUsedRangeOrNullObject(true));
      const tables = sheets.map((s) => s.tables);
      const charts = sheets.map((s) => s.charts);
      useds.forEach((u) => u.load(["address", "rowCount", "columnCount"]));
      tables.forEach((t) => t.load("items/name"));
      charts.forEach((c) => c.load("items/name"));
      await ctx.sync();

      const headerRanges = useds.map((u) => (u.isNullObject ? null : u.getRow(0)));
      headerRanges.forEach((h) => { if (h) h.load("values"); });
      await ctx.sync();

      const out = sheets.map((s, i) => {
        const u = useds[i];
        const empty = u.isNullObject;
        const headerRow = (!empty && headerRanges[i] && headerRanges[i].values) ? headerRanges[i].values[0] : null;
        const headers = headerRow
          ? headerRow.map((v) => (v === "" || v == null ? null : String(v))).slice(0, 50)
          : [];
        return {
          name: s.name,
          position: s.position,
          hidden: s.visibility !== "Visible",
          usedRange: empty ? null : u.address,
          rows: empty ? 0 : u.rowCount,
          columns: empty ? 0 : u.columnCount,
          headers,
          tables: tables[i].items.map((t) => t.name),
          charts: charts[i].items.length,
        };
      });

      return {
        sheetCount: sheets.length,
        sheets: out,
        namedRanges: names.items
          .filter((n) => n.visible !== false)
          .map((n) => ({ name: n.name, refersTo: n.formula, type: n.type }))
          .slice(0, 100),
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

  async trace_cell({ address }) {
    const base = await Excel.run(async (ctx) => {
      const cell = parseRange(ctx, address).getCell(0, 0);
      cell.load(["address", "formulas", "values"]);
      await ctx.sync();
      return { address: cell.address, formula: cell.formulas?.[0]?.[0] ?? "", value: cell.values?.[0]?.[0] ?? "" };
    });
    // Precedents/dependents throw when there are none, so isolate each in its own run.
    const grab = async (which) => {
      try {
        return await Excel.run(async (ctx) => {
          const cell = parseRange(ctx, base.address).getCell(0, 0);
          const areas = which === "precedents" ? cell.getDirectPrecedents() : cell.getDirectDependents();
          areas.load("areas/address");
          await ctx.sync();
          return areas.areas.items.map((a) => a.address);
        });
      } catch { return null; }
    };
    const precedents = await grab("precedents");
    const dependents = await grab("dependents");
    return {
      address: base.address,
      formula: base.formula,
      value: base.value,
      precedents: precedents || [],
      dependents: dependents || [],
      ...(precedents === null ? { precedentsNote: "Inga direkta föregångare (eller stöds ej i din Excel-version)." } : {}),
      ...(dependents === null ? { dependentsNote: "Inga direkta beroenden (eller stöds ej i din Excel-version)." } : {}),
    };
  },

  async list_charts() {
    return Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const charts = sheet.charts;
      sheet.load("name");
      charts.load("items/name,items/chartType");
      await ctx.sync();
      return {
        sheet: sheet.name,
        charts: charts.items.map((c) => ({ name: c.name, type: c.chartType })),
      };
    });
  },

  async capture_view({ address } = {}) {
    try {
      const result = await Excel.run(async (ctx) => {
        const range = address ? parseRange(ctx, address) : ctx.workbook.getSelectedRange();
        range.load("address");
        const img = range.getImage(); // ExcelApi 1.9
        await ctx.sync();
        return { address: range.address, data: img.value };
      });
      return { captured: true, address: result.address, image: { media_type: "image/png", data: result.data } };
    } catch (e) {
      return { error: `Kunde inte fånga bilden${e?.message ? ": " + e.message : ""} (kräver en nyare version av Excel).` };
    }
  },

  async analyze_data({ address, question }) {
    let csv;
    try {
      csv = await Excel.run(async (ctx) => {
        const range = parseRange(ctx, address);
        range.load("values");
        await ctx.sync();
        return (range.values || []).slice(0, 500).map((r) => r.map(csvCell).join(",")).join("\n");
      });
    } catch (e) { return { error: `Kunde inte läsa ${address}${e?.message ? ": " + e.message : ""}.` }; }
    if (!csv) return { error: "Området är tomt." };
    try {
      const r = await fetch(`${API_BASE}/api/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: csv, question, address }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || "Analysen misslyckades." }; }
      const j = await r.json();
      return { analysis: j.text, address };
    } catch { return { error: "Kunde inte nå analystjänsten." }; }
  },

  async run_code({ task, data }) {
    try {
      const r = await fetch(`${API_BASE}/api/code`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, data }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || "Körningen misslyckades." }; }
      const j = await r.json();
      return { result: j.text };
    } catch { return { error: "Kunde inte nå kodtjänsten." }; }
  },

  async web_lookup({ query }) {
    try {
      const r = await fetch(`${API_BASE}/api/research`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || "Sökningen misslyckades." }; }
      const j = await r.json();
      return { result: j.text };
    } catch { return { error: "Kunde inte nå söktjänsten." }; }
  },

  async create_document({ kind, instructions }) {
    try {
      const r = await fetch(`${API_BASE}/api/document`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, instructions }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || "Kunde inte skapa dokumentet." }; }
      const j = await r.json();
      renderDownload(j.filename, j.data, j.media_type); // show a clickable download in the chat
      return { created: true, filename: j.filename };
    } catch { return { error: "Kunde inte nå dokumenttjänsten." }; }
  },

  async list_files({ query } = {}) {
    const token = await getSsoToken(false); // silent — never pop a dialog mid-answer
    if (!token) return { error: "Logga in med Microsoft för att nå dina filer (Inställningar → Logga in)." };
    try {
      const r = await fetch(`${API_BASE}/api/files?q=${encodeURIComponent(query || "")}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || "Kunde inte hämta filer." }; }
      const j = await r.json();
      return { files: (j.files || []).map((f) => ({ id: f.id, name: f.name, size: f.size, modified: f.modified })) };
    } catch { return { error: "Kunde inte nå filtjänsten." }; }
  },

  async open_file({ id, name }) {
    const token = await getSsoToken(false); // silent — never pop a dialog mid-answer
    if (!token) return { error: "Logga in med Microsoft först (Inställningar → Logga in)." };
    try {
      const r = await fetch(`${API_BASE}/api/files/open`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || "Kunde inte öppna filen." }; }
      const j = await r.json();
      if (j.kind === "text") return { name: j.name, text: j.text };
      if (j.kind === "image") return { name: j.name, image: { media_type: j.media_type, data: j.data } };
      if (j.kind === "pdf") return { name: j.name, document: { media_type: "application/pdf", data: j.data } };
      return { error: "Okänt filinnehåll." };
    } catch { return { error: "Kunde inte nå filtjänsten." }; }
  },

  /* ---------------- Outlook mail ---------------- */

  async list_emails({ query, folder, limit } = {}) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att nå din e-post (Inställningar → Logga in)." };
    try {
      const p = new URLSearchParams();
      if (query) p.set("q", query);
      if (folder) p.set("folder", folder);
      if (limit) p.set("top", String(limit));
      const r = await fetch(`${API_BASE}/api/mail?${p.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte hämta e-post." };
      return { messages: (j.messages || []).map((m) => ({ id: m.id, subject: m.subject, from: m.from, fromName: m.fromName, received: m.received, preview: m.preview, isRead: m.isRead, hasAttachments: m.hasAttachments })) };
    } catch { return { error: "Kunde inte nå e-posttjänsten." }; }
  },

  async read_email({ id }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft först." };
    if (!id) return { error: "Ange meddelandets id (från list_emails)." };
    try {
      const r = await fetch(`${API_BASE}/api/mail/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte öppna meddelandet." };
      return { message: j.message };
    } catch { return { error: "Kunde inte nå e-posttjänsten." }; }
  },

  async read_current_email() {
    try {
      const item = (typeof Office !== "undefined") && Office.context && Office.context.mailbox && Office.context.mailbox.item;
      if (!item) return { error: "Det här fungerar bara i Outlook med ett mejl öppet." };
      const out = { id: item.itemId || null };
      if (typeof item.subject === "string") out.subject = item.subject; // read mode
      const from = item.from || item.sender;
      if (from && from.emailAddress) { out.from = from.emailAddress; out.fromName = from.displayName || ""; }
      if (Array.isArray(item.to)) out.to = item.to.map((r) => r.emailAddress).filter(Boolean);
      out.body = await new Promise((resolve) => {
        try {
          if (item.body && typeof item.body.getAsync === "function") {
            item.body.getAsync("text", (res) => resolve(res && res.status === "succeeded" ? String(res.value || "").slice(0, 50000) : ""));
          } else resolve("");
        } catch { resolve(""); }
      });
      return out;
    } catch (e) { return { error: e.message || "Kunde inte läsa det öppna mejlet." }; }
  },

  async send_email({ to, cc, subject, body, reply_to_id }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft först." };
    if (!String(body || "").trim()) return { error: "Mejlet saknar innehåll." };
    if (!reply_to_id && !String(to || "").trim()) return { error: "Ange minst en mottagare." };
    // Sending mail is consequential — always confirm with a preview, regardless of edit mode.
    const ok = await confirmSend({ to: reply_to_id ? "(svar i tråden)" : to, cc, subject, body });
    if (!ok) return { skipped: true, reason: "Användaren avbröt utskicket." };
    try {
      const r = await fetch(`${API_BASE}/api/mail/send`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, cc, subject, body, replyToId: reply_to_id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte skicka mejlet." };
      toast("Mejlet skickades", "success");
      return { sent: true };
    } catch { return { error: "Kunde inte nå e-posttjänsten." }; }
  },

  /* ---------------- scheduled jobs (server-side agent) ---------------- */

  async schedule_task({ name, prompt, file_id, freq, time, weekday, monthday, on_date, notify }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att schemalägga (Inställningar → Logga in)." };
    if (!String(prompt || "").trim()) return { error: "Ange vad schemat ska göra." };
    if (!file_id) return { error: "Ange vilken molnfil schemat kör mot — använd list_files för att hitta dess id." };
    const schedule = { freq: freq || "daily", time: time || "09:00", tzOffset: new Date().getTimezoneOffset() };
    if (weekday != null) schedule.weekday = weekday;
    if (monthday != null) schedule.monthday = monthday;
    if (on_date) schedule.onDate = on_date;
    try {
      const r = await fetch(`${API_BASE}/api/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: name || "Schema", prompt, schedule, itemId: file_id, notify: notify !== false }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte skapa schemat." };
      const job = j.job || {};
      return { scheduled: true, id: job.id, name: job.name, nextRun: job.nextRun ? new Date(job.nextRun).toISOString() : null };
    } catch { return { error: "Kunde inte nå schematjänsten." }; }
  },

  async list_schedules() {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att se scheman." };
    try {
      const r = await fetch(`${API_BASE}/api/jobs`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte hämta scheman." };
      return {
        schedulerEnabled: !!j.schedulerEnabled,
        jobs: (j.jobs || []).map((job) => ({
          id: job.id, name: job.name, prompt: job.prompt, enabled: job.enabled,
          schedule: job.schedule, file: job.target?.fileName || "",
          nextRun: job.nextRun ? new Date(job.nextRun).toISOString() : null,
          lastStatus: job.lastStatus, lastResult: job.lastResult,
        })),
      };
    } catch { return { error: "Kunde inte nå schematjänsten." }; }
  },

  async cancel_schedule({ id }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft först." };
    if (!id) return { error: "Ange schemats id (se list_schedules)." };
    try {
      const r = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { const j = await r.json().catch(() => ({})); return { error: j.error || "Kunde inte ta bort schemat." }; }
      return { cancelled: true, id };
    } catch { return { error: "Kunde inte nå schematjänsten." }; }
  },

  /* ---------------- write / mutate (gated by edit mode) ---------------- */

  async write_range({ address, values }) {
    if (!is2DArray(values)) return { error: "values måste vara en icke-tom 2D-array (rader av kolumner)." };
    const ok = await gateEdit({ kind: "values", address, values });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load(["formulas", "address"]);
      await ctx.sync();
      pushUndo(range.address, range.formulas);
      range.values = values;
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
      range.load(["rowCount", "columnCount", "formulas", "address"]);
      await ctx.sync();
      pushUndo(range.address, range.formulas);
      range.formulas = grid(range.rowCount, range.columnCount, formula);
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
      range.load(["formulas", "address"]);
      await ctx.sync();
      pushUndo(range.address, range.formulas);
      range.formulas = formulas;
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
      range.load(["formulas", "address"]);
      await ctx.sync();
      pushUndo(range.address, range.formulas);
      range.clear(map[what] || "Contents");
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

  async search_vault({ query }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att nå företagets kunskapsbank." };
    try {
      const r = await fetch(`${API_BASE}/api/vault?q=${encodeURIComponent(query || "")}`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte söka i kunskapsbanken." };
      return { entries: (j.entries || []).map((e) => ({ topic: e.topic, title: e.title, content: e.content, tags: e.tags })) };
    } catch { return { error: "Kunde inte nå kunskapsbanken." }; }
  },

  async save_to_vault({ topic, title, content, tags }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att spara i företagets kunskapsbank." };
    if (!String(title || "").trim() || !String(content || "").trim()) return { error: "Ange titel och innehåll." };
    try {
      const r = await fetch(`${API_BASE}/api/vault`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ topic, title, content, tags }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte spara i kunskapsbanken." };
      toast("Sparade i kunskapsbanken", "success");
      return { saved: true, id: j.entry?.id, topic: j.entry?.topic, title: j.entry?.title };
    } catch { return { error: "Kunde inte nå kunskapsbanken." }; }
  },

  async save_to_workspace({ label, content, source }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att synka arbetsutrymmet mellan appar." };
    if (!String(content || "").trim()) return { error: "Inget innehåll att spara." };
    try {
      const r = await fetch(`${API_BASE}/api/workspace`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ label: label || "Notis", content, source: source || (IS_EXCEL ? "Excel" : "Simba") }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte spara." };
      toast("Sparat i arbetsutrymmet", "success", 1500);
      return { saved: true, id: j.item?.id, label: j.item?.label };
    } catch { return { error: "Kunde inte nå arbetsutrymmet." }; }
  },

  async get_workspace() {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att nå arbetsutrymmet." };
    try {
      const r = await fetch(`${API_BASE}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte hämta arbetsutrymmet." };
      return { items: (j.items || []).map((i) => ({ id: i.id, label: i.label, content: i.content, source: i.source })) };
    } catch { return { error: "Kunde inte nå arbetsutrymmet." }; }
  },

  async list_data_sources() {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att nå företagets datakällor." };
    try {
      const r = await fetch(`${API_BASE}/api/connectors`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte hämta datakällor." };
      return { sources: (j.connectors || []).map((c) => ({ name: c.name, endpoints: (c.endpoints || []).map((e) => ({ key: e.key, label: e.label, description: e.description })) })) };
    } catch { return { error: "Kunde inte nå datakälletjänsten." }; }
  },

  async query_data_source({ source, endpoint, params }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att hämta data." };
    if (!source || !endpoint) return { error: "Ange datakälla och endpoint (se list_data_sources)." };
    try {
      const r = await fetch(`${API_BASE}/api/connectors/query`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ source, endpoint, params }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte hämta data." };
      return { source: j.source, endpoint: j.endpoint, data: j.data };
    } catch { return { error: "Kunde inte nå datakälletjänsten." }; }
  },

  async analyze_vault({ focus }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft för att analysera kunskapsbanken." };
    try {
      const r = await fetch(`${API_BASE}/api/vault/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ focus }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte analysera." };
      return { analysis: j.text, count: j.count };
    } catch { return { error: "Kunde inte nå kunskapsbanken." }; }
  },

  async open_vault_file({ id }) {
    const token = await getSsoToken(false);
    if (!token) return { error: "Logga in med Microsoft först." };
    if (!id) return { error: "Ange postens id (från search_vault)." };
    try {
      const r = await fetch(`${API_BASE}/api/vault/${encodeURIComponent(id)}/file`, { headers: { Authorization: `Bearer ${token}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "Kunde inte öppna bilagan." };
      if (j.kind === "text") return { name: j.name, text: j.text };
      if (j.kind === "image") return { name: j.name, image: { media_type: j.media_type, data: j.data } };
      if (j.kind === "pdf") return { name: j.name, document: { media_type: "application/pdf", data: j.data } };
      return { error: "Okänt filinnehåll." };
    } catch { return { error: "Kunde inte nå kunskapsbanken." }; }
  },

  /* ---------------- agent control: plan + delegate ---------------- */

  async propose_plan({ title, steps }) {
    const list = Array.isArray(steps) ? steps.map((s) => String(s).trim()).filter(Boolean) : [];
    if (!list.length) return { error: "Planen saknar steg." };
    renderPlan(title, list); // leave the plan visible in the chat as a record
    if (editMode === "auto" || autoApproveTurn) return { approved: true, note: "Autoläge — kör direkt." };
    const ok = await confirmPlan(title || "Planen");
    return ok
      ? { approved: true }
      : { approved: false, reason: "Användaren avböjde planen. Föreslå inte samma plan igen — fråga vad som ska ändras." };
  },

  async delegate_task({ task, context }) {
    const goal = String(task || "").trim();
    if (!goal) return { error: "Ingen uppgift angavs." };
    if (subagentDepth > 0) return { error: "En subagent kan inte delegera vidare." };
    const intro = context ? `${String(context).trim()}\n\nUppgift: ${goal}` : `Uppgift: ${goal}`;
    const sub = [{
      role: "user",
      content: `Du är en fokuserad subagent åt Simba. Utför ENBART denna avgränsade uppgift, helt och hållet, och svara sedan med ett KORT resultat (vad du gjorde, viktiga adresser/siffror). Be aldrig om förtydliganden — gör rimliga antaganden.\n\n${intro}`,
    }];
    subagentDepth++;
    let steps = 0;
    try {
      for (let i = 0; i < 10; i++) {
        const reply = await callBackend(sub, null); // silent: no streaming bubble for sub-steps
        if (!reply || !Array.isArray(reply.content)) return { done: false, steps, summary: "Subagenten gav ett oväntat svar." };
        sub.push({ role: "assistant", content: reply.content });
        if (reply.stop_reason !== "tool_use") {
          const text = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
          return { done: true, steps, summary: text || "(subagenten slutförde utan textsvar)" };
        }
        const toolUses = reply.content.filter((b) => b.type === "tool_use");
        const results = [];
        for (const use of toolUses) {
          steps++;
          let result, isError = false;
          try {
            if (use.name === "delegate_task" || use.name === "propose_plan") {
              result = { error: "Inte tillgängligt inuti en subagent." };
            } else if (!toolAllowed(use.name)) {
              result = { error: "Det här kräver Excel." };
            } else {
              const fn = tools[use.name];
              result = fn ? await fn(use.input || {}) : { error: `Okänt verktyg ${use.name}` };
            }
          } catch (e) { result = { error: e.message || String(e) }; isError = true; }
          if (result && result.error) isError = true;
          results.push({ type: "tool_result", tool_use_id: use.id, content: toolResultContent(result), is_error: isError });
        }
        sub.push({ role: "user", content: results });
      }
      return { done: false, steps, summary: "Subagenten nådde stegtaket utan att bli klar." };
    } finally {
      subagentDepth--;
    }
  },

  async merge_cells({ address, across = false }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Sammanfoga ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load(["values", "address"]);
      await ctx.sync();
      // Office.js merge KEEPS ONLY the top-left cell and silently discards the
      // rest — which wipes a title written into a centered/non-top-left cell.
      // Move the first non-empty value into the cell merge will keep, so the
      // title survives. (across = merge each row, so preserve per row.)
      const vals = range.values || [];
      const nonEmpty = (v) => v !== "" && v != null;
      const firstIn = (arr) => { for (const v of arr || []) if (nonEmpty(v)) return v; return undefined; };
      if (across) {
        for (let r = 0; r < vals.length; r++) {
          if (!nonEmpty(vals[r]?.[0])) { const v = firstIn(vals[r]); if (v !== undefined) range.getCell(r, 0).values = [[v]]; }
        }
      } else if (!nonEmpty(vals[0]?.[0])) {
        let v; for (const row of vals) { v = firstIn(row); if (v !== undefined) break; }
        if (v !== undefined) range.getCell(0, 0).values = [[v]];
      }
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

  async find_errors() {
    return Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const used = sheet.getUsedRangeOrNullObject(true);
      used.load(["values", "rowIndex", "columnIndex"]);
      await ctx.sync();
      if (used.isNullObject) return { errors: [], count: 0 };
      const ERR = /^#(REF|DIV\/0|VALUE|NAME\?|N\/A|NULL|NUM)/i;
      const errors = [];
      for (let r = 0; r < used.values.length && errors.length < 200; r++) {
        for (let c = 0; c < used.values[r].length; c++) {
          const v = used.values[r][c];
          if (typeof v === "string" && v[0] === "#" && ERR.test(v))
            errors.push({ address: `${colLetter(used.columnIndex + c)}${used.rowIndex + r + 1}`, error: v });
        }
      }
      return { errors, count: errors.length };
    });
  },

  async conditional_formatting({ address, type, value, color }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Villkorsstyrd formatering (${type}) på ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      const cfs = range.conditionalFormats;
      const fill = color || "#FFC7CE";
      if (type === "data_bar") {
        cfs.add(Excel.ConditionalFormatType.dataBar);
      } else if (type === "color_scale") {
        const cf = cfs.add(Excel.ConditionalFormatType.colorScale);
        cf.colorScale.criteria = {
          minimum: { formula: null, type: Excel.ConditionalFormatColorCriterionType.lowestValue, color: "#F8696B" },
          midpoint: { formula: "50", type: Excel.ConditionalFormatColorCriterionType.percentile, color: "#FFEB84" },
          maximum: { formula: null, type: Excel.ConditionalFormatColorCriterionType.highestValue, color: "#63BE7B" },
        };
      } else if (type === "duplicates") {
        const cf = cfs.add(Excel.ConditionalFormatType.presetCriteria);
        cf.preset.format.fill.color = fill;
        cf.preset.rule = { criterion: Excel.ConditionalFormatPresetCriterion.duplicateValues };
      } else {
        const opMap = { greater_than: "GreaterThan", less_than: "LessThan", equal_to: "EqualTo" };
        const cf = cfs.add(Excel.ConditionalFormatType.cellValue);
        cf.cellValue.format.fill.color = fill;
        cf.cellValue.rule = { formula1: String(value ?? 0), operator: opMap[type] || "GreaterThan" };
      }
      range.load("address");
      await ctx.sync();
      return { applied: true, address: range.address, type };
    });
    toast(`Villkorsformaterade ${result.address}`, "success");
    return result;
  },

  async data_validation({ address, values }) {
    const list = Array.isArray(values) ? values : String(values || "").split(",");
    const source = list.map((v) => String(v).trim()).filter(Boolean).join(",");
    if (!source) return { error: "Inga alternativ angavs." };
    const ok = await gateEdit({ kind: "edit", address, summary: `Rullgardin (${source}) på ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.dataValidation.rule = { list: { inCellDropDown: true, source: source.slice(0, 255) } };
      range.load("address");
      await ctx.sync();
      return { applied: true, address: range.address, options: list.length };
    });
    toast(`La till rullgardin i ${result.address}`, "success");
    return result;
  },

  async add_comment({ address, text }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Kommentar på ${address}` });
    if (!ok) return declined(ok);
    await Excel.run(async (ctx) => {
      ctx.workbook.comments.add(address, String(text || ""));
      await ctx.sync();
    });
    toast(`La till kommentar i ${address}`, "success");
    return { added: true, address };
  },

  async create_pivot_table({ source_range, destination, rows = [], values = [], columns = [], name }) {
    if (!Array.isArray(values) || values.length === 0) return { error: "Ange minst ett värdefält att summera." };
    const ok = await gateEdit({ kind: "edit", address: destination, summary: `Skapa en pivottabell från ${source_range}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const src = parseRange(ctx, source_range);
      const dest = parseRange(ctx, destination);
      const pivot = ctx.workbook.pivotTables.add(name || "Pivot", src, dest);
      for (const f of rows) pivot.rowHierarchies.add(pivot.hierarchies.getItem(f));
      for (const f of columns) pivot.columnHierarchies.add(pivot.hierarchies.getItem(f));
      for (const f of values) pivot.dataHierarchies.add(pivot.hierarchies.getItem(f));
      pivot.load("name");
      await ctx.sync();
      return { created: true, pivot: pivot.name, destination };
    });
    toast(`Skapade pivottabell ${result.pivot}`, "success");
    return result;
  },

  async apply_filter({ address, column_index, values }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Filtrera ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet();
      const range = parseRange(ctx, address);
      const criteria = (typeof column_index === "number" && Array.isArray(values) && values.length)
        ? { filterOn: Excel.FilterOn.values, values: values.map(String) }
        : null;
      if (criteria) sheet.autoFilter.apply(range, column_index, criteria);
      else sheet.autoFilter.apply(range);
      range.load("address");
      await ctx.sync();
      return { applied: true, address: range.address, filtered: !!criteria };
    });
    toast(result.filtered ? "Filtrerade data" : "Slog på filter", "success");
    return result;
  },

  async remove_duplicates({ address, columns, has_headers = true }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Ta bort dubbletter i ${address}` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load("address, formulas");
      await ctx.sync();
      pushUndo(range.address, range.formulas);
      const colCount = range.formulas[0] ? range.formulas[0].length : 1;
      const cols = Array.isArray(columns) && columns.length
        ? columns
        : Array.from({ length: colCount }, (_, i) => i);
      const del = range.removeDuplicates(cols, has_headers);
      del.load("removed, uniqueRemaining");
      await ctx.sync();
      return { removed: del.removed, uniqueRemaining: del.uniqueRemaining, address: range.address };
    });
    toast(`Tog bort ${result.removed} dubbletter`, "success");
    return result;
  },

  async create_named_range({ name, address }) {
    const ok = await gateEdit({ kind: "edit", address, summary: `Namnge ${address} som "${name}"` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load("address");
      await ctx.sync();
      ctx.workbook.names.add(name, range);
      await ctx.sync();
      return { created: true, name, address: range.address };
    });
    toast(`Skapade namngivet område "${name}"`, "success");
    return result;
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

  async update_chart({ name, chart_type, title, show_legend, legend_position, show_data_labels, x_axis_title, y_axis_title, series_colors }) {
    const ok = await gateEdit({ kind: "edit", summary: `Uppdatera diagrammet "${name}"` });
    if (!ok) return declined(ok);
    const result = await Excel.run(async (ctx) => {
      const chart = ctx.workbook.worksheets.getActiveWorksheet().charts.getItem(name);
      if (chart_type) chart.chartType = chart_type;
      if (title != null) { chart.title.text = String(title); chart.title.visible = true; }
      if (typeof show_legend === "boolean") chart.legend.visible = show_legend;
      if (legend_position) chart.legend.position = legend_position;
      if (typeof show_data_labels === "boolean") chart.dataLabels.visible = show_data_labels;
      if (x_axis_title != null) { chart.axes.categoryAxis.title.text = String(x_axis_title); chart.axes.categoryAxis.title.visible = true; }
      if (y_axis_title != null) { chart.axes.valueAxis.title.text = String(y_axis_title); chart.axes.valueAxis.title.visible = true; }
      if (Array.isArray(series_colors) && series_colors.length) {
        chart.series.load("items");
        await ctx.sync();
        series_colors.forEach((col, i) => {
          if (col && chart.series.items[i]) chart.series.items[i].format.fill.setSolidColor(String(col));
        });
      }
      chart.load("name,chartType");
      await ctx.sync();
      return { updated: true, name: chart.name, type: chart.chartType };
    });
    toast(`Uppdaterade diagrammet ${result.name}`, "success");
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

  async revert_last_change() {
    const snap = undoStack.pop();
    updateUndoButton();
    if (!snap) return { reverted: false, reason: "Det finns inget att ångra." };
    const result = await Excel.run(async (ctx) => {
      const range = parseRange(ctx, snap.address);
      range.formulas = snap.formulas;        // restores both formulas and literal values
      range.select();
      await ctx.sync();
      refreshContextPill();
      return { reverted: true, address: snap.address };
    });
    toast(`Ångrade ändringen i ${result.address}`, "success");
    return result;
  },
};

/* tool helpers */
const MAX_READ_CELLS = 20000;
const undoStack = []; // {address, formulas} snapshots taken before data edits
function pushUndo(address, formulas) {
  undoStack.push({ address, formulas });
  if (undoStack.length > 30) undoStack.shift();
  updateUndoButton();
}
function updateUndoButton() {
  if (els.undo) els.undo.disabled = undoStack.length === 0;
}
function is2DArray(v) { return Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r)); }
function csvCell(c) { const s = c == null ? "" : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
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
  if ((!text && !pendingAttachments.length) || busy) return;

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

  const atts = pendingAttachments;
  const agentNote = activeAgent ? `${activeAgent.directive}\n\n` : "";
  const fallback = atts.length === 1 ? `Titta på den bifogade filen "${atts[0].name}".`
    : atts.length > 1 ? `Titta på de ${atts.length} bifogade filerna.` : "";
  const promptText = agentNote + (text || fallback) + selectionNote;
  // With attachments, content is a block array (files first, then the question).
  const content = atts.length ? [...atts.map((a) => a.block), { type: "text", text: promptText }] : promptText;
  messages.push({ role: "user", content });
  renderMessage("user", text, atts.length ? { file: atts.map((a) => a.name).join(", ") } : null);
  clearAttachment();
  if (activeAgent) renderAgentRun(activeAgent); // show the specialist sub-agent picking up the task

  autoApproveTurn = false; // each new request starts asking again
  stopRequested = false;   // fresh turn
  setBusy(true);
  renderTyping();
  try {
    await runAgentLoop();
    if (!stopRequested) cheerMascot(); // a little happy wag when Simba finishes
  } catch (err) {
    if (!stopRequested) toast(err.message || "Något gick fel i kommunikationen med Simba.", "error", 4000);
  } finally {
    clearTyping();
    setBusy(false);
    activeController = null;
    if (stopRequested) toast("Stoppade", "info", 1500);
    stopRequested = false;
    pruneHeavyHistory();
    saveConversation();
  }
}

async function regenerate() {
  if (busy) return;
  let idx = -1;
  for (let k = messages.length - 1; k >= 0; k--) {
    // last real user turn (string text, or a block array — e.g. with an attachment),
    // not a tool_result user turn (those are arrays of tool_result blocks)
    const c = messages[k].content;
    const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
    if (messages[k].role === "user" && !isToolResult) { idx = k; break; }
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
    pruneHeavyHistory();
    saveConversation();
  }
}

// Read-only tools (no side effects) — safe to run concurrently within a turn.
const READ_TOOLS = new Set([
  "get_selection", "read_range", "get_sheet_info", "list_sheets", "describe_workbook",
  "find", "capture_view", "analyze_data", "web_lookup", "run_code", "trace_cell",
  "list_charts", "list_files", "open_file", "list_schedules",
  "search_vault", "analyze_vault", "open_vault_file", "get_workspace", "list_data_sources", "query_data_source", "list_emails", "read_email", "read_current_email",
]);

// Run a single tool call: render its activity step, execute it (respecting the
// desktop/Excel gate), and return the tool_result block for the model.
async function runOneTool(use, group) {
  const step = groupAddStep(group, use.name, use.input);
  let result, isError = false;
  try {
    const fn = tools[use.name];
    if (!toolAllowed(use.name)) {
      result = { error: "Det här kräver Excel. Öppna Simba inuti Excel för att läsa eller redigera arket." };
    } else {
      result = fn ? await fn(use.input || {}) : { error: `Okänt verktyg ${use.name}` };
    }
  } catch (e) {
    result = { error: e.message || String(e) };
    isError = true;
  }
  if (result && result.error) isError = true;
  markStepDone(group, step, isError, toolResultHint(use.name, use.input, result));
  return { type: "tool_result", tool_use_id: use.id, content: toolResultContent(result), is_error: isError };
}

// Build the content blocks for a tool_result: images/PDFs go in as real
// vision/document blocks so the model can SEE them; everything else is JSON.
function toolResultContent(result) {
  if (result && result.image && result.image.data) {
    return [
      { type: "image", source: { type: "base64", media_type: result.image.media_type || "image/png", data: result.image.data } },
      { type: "text", text: `(bild: ${result.name || result.address || "fil"})` },
    ];
  }
  if (result && result.document && result.document.data) {
    return [
      { type: "document", source: { type: "base64", media_type: result.document.media_type || "application/pdf", data: result.document.data } },
      { type: "text", text: `(dokument: ${result.name || "fil"})` },
    ];
  }
  return JSON.stringify(result);
}

async function runAgentLoop() {
  let group = null; // collapsible activity card for this turn's tool steps
  for (let i = 0; i < 12; i++) {
    if (stopRequested) { finalizeToolGroup(group); return; } // user pressed Stop between turns
    let live = null; // the streaming reply bubble for this iteration
    const onDelta = (chunk) => {
      if (!chunk) return;
      if (group) { finalizeToolGroup(group); group = null; } // close the card before the reply
      if (!live) live = startStream();
      appendStream(live, chunk);
    };

    let reply;
    try {
      reply = await callBackend(messages, onDelta);
    } catch (e) {
      if (live) { if (live.text.trim()) finishStream(live, live.text.trim()); else live.wrap.remove(); }
      finalizeToolGroup(group);         // stop the running shimmer on error/stop
      if (stopRequested) return;        // clean user-stop: keep whatever streamed, no error
      throw e;
    }
    if (!reply || !Array.isArray(reply.content)) {
      if (live) live.wrap.remove();
      finalizeToolGroup(group);
      throw new Error("Simba returnerade ett oväntat svar.");
    }
    messages.push({ role: "assistant", content: reply.content });

    const fullText = reply.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
    if (live) {
      if (fullText || live.text.trim()) finishStream(live, fullText); // re-render as rich markdown
      else live.wrap.remove();                                        // nothing real streamed → drop empty bubble
    } else if (fullText) {                                            // non-streaming fallback
      if (group) { finalizeToolGroup(group); group = null; }
      renderMessage("assistant", fullText);
    }

    if (reply.stop_reason !== "tool_use") { finalizeToolGroup(group); return; }

    const toolUses = reply.content.filter((b) => b.type === "tool_use");
    if (toolUses.length && !group) group = createToolGroup();
    // Read-only steps have no side effects and can run concurrently — a big
    // latency win on "thinking" turns that fan out several reads. Anything that
    // mutates the sheet (or could prompt for confirmation) runs sequentially in
    // order, since order matters and parallel edit dialogs would collide.
    let results;
    if (toolUses.length > 1 && toolUses.every((u) => READ_TOOLS.has(u.name))) {
      results = await Promise.all(toolUses.map((use) => runOneTool(use, group)));
    } else {
      results = [];
      for (const use of toolUses) results.push(await runOneTool(use, group));
    }
    messages.push({ role: "user", content: results });
  }
  finalizeToolGroup(group);
  renderMessage("assistant", "_(Stoppade efter för många steg. Försök att avgränsa förfrågan.)_");
}

async function callBackend(history, onDelta) {
  const ctrl = new AbortController();
  activeController = ctrl; // so the Stop button can abort this request
  const timer = setTimeout(() => ctrl.abort(), 180000);
  const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };
  const tok = await getSsoToken(false); // lets the server attribute per-user quota (optional)
  if (tok) headers.Authorization = `Bearer ${tok}`;
  let res;
  try {
    res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ messages: history, speed, memory: memoryList(), surface: IS_EXCEL ? "excel" : (IS_OUTLOOK ? "outlook" : "desktop") }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(
      e && e.name === "AbortError"
        ? "Simba tog för lång tid på sig att svara. Försök igen."
        : "Kan inte nå Simba. Kontrollera din anslutning och att servern körs."
    );
  }
  if (!res.ok) {
    clearTimeout(timer);
    let msg = `Simba serverfel (${res.status}).`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  const ctype = res.headers.get("content-type") || "";
  // Fallback for a non-streaming server (e.g. mid-rollout): plain JSON reply.
  if (!ctype.includes("text/event-stream") || !res.body?.getReader) {
    clearTimeout(timer);
    return res.json();
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let final = null;
  const handleFrame = (raw) => {
    const ev = parseSSE(raw);
    if (!ev) return;
    if (ev.event === "delta") { try { onDelta?.(JSON.parse(ev.data).text); } catch { /* ignore */ } }
    else if (ev.event === "final") { try { final = JSON.parse(ev.data); } catch { /* ignore */ } }
    else if (ev.event === "error") {
      let m = "Claude API request failed.";
      try { m = JSON.parse(ev.data).error || m; } catch { /* ignore */ }
      throw new Error(m);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        handleFrame(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    buf += decoder.decode();      // flush any trailing multi-byte bytes
    if (buf.trim()) handleFrame(buf); // parse a final frame not terminated by \n\n
  } finally {
    clearTimeout(timer);
  }
  if (!final) throw new Error("Simba returnerade ett ofullständigt svar.");
  return final;
}

function parseSSE(block) {
  let event = "message", data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
  }
  return data ? { event, data } : null;
}

/* ------------------------------------------------------------------ *
 * Popups: confirmation + settings
 * ------------------------------------------------------------------ */

let modalResolver = null;

function openModal(html, { onClose } = {}) {
  els.modalCard.classList.remove("wide"); // reset any artifact-size from a prior modal
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

// Render Simba's proposed plan as a tidy card in the chat so it stays visible
// while (and after) the user decides whether to run it.
function renderPlan(title, steps) {
  const md = `**📋 ${title || "Plan"}**\n\n` + steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  renderMessage("assistant", md);
}

/** Asks the user to approve a proposed plan; resolves true (run) / false (cancel). */
function confirmPlan(title) {
  return new Promise((resolve) => {
    const dock = els.askDock;
    let settled = false;
    const card = document.createElement("div");
    card.className = "ask-card";
    card.innerHTML =
      `<div class="ask-head"><span class="ask-ic" aria-hidden="true">📋</span><span class="ask-sub">Simba föreslår en plan.</span></div>
       <div class="ask-body"><p class="confirm-summary">${escapeHtml(title)} — se planen ovan. Köra den?</p></div>
       <div class="ask-actions">
         <button class="btn" type="button" data-act="cancel">Avbryt</button>
         <button class="btn ghost" type="button" data-act="all" title="Kör planen och godkänn alla ändringar i den">Kör + godkänn alla</button>
         <button class="btn primary" type="button" data-act="apply">Kör planen</button>
       </div>
       <p class="ask-hint">Enter för att köra · Skift+Enter för att godkänna alla · Esc för att avbryta</p>`;
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      else if (e.key === "Enter" && e.shiftKey) { e.preventDefault(); finish("all"); }
      else if (e.key === "Enter") { e.preventDefault(); finish(true); }
    };
    function finish(v) {
      if (settled) return;
      settled = true;
      if (v === "all") autoApproveTurn = true; // run the plan without prompting on each edit
      document.removeEventListener("keydown", onKey);
      card.classList.add("leaving");
      card.addEventListener("animationend", () => card.remove(), { once: true });
      setTimeout(() => card.remove(), 260);
      resolve(v === "all" ? true : v);
    }
    dock.innerHTML = "";
    dock.appendChild(card);
    card.querySelector('[data-act="apply"]').onclick = () => finish(true);
    card.querySelector('[data-act="all"]').onclick = () => finish("all");
    card.querySelector('[data-act="cancel"]').onclick = () => finish(false);
    document.addEventListener("keydown", onKey);
    setTimeout(() => card.querySelector('[data-act="apply"]').focus(), 30);
  });
}

// Modal-based prompt/confirm (native window.prompt/confirm are blocked inside
// the Office task pane, so we roll our own that work on every surface).
// Render a model-generated HTML/SVG snippet in a sandboxed preview (artifacts).
function openArtifact(html) {
  openModal(
    `<div class="artifact-head"><h3 style="margin:0">Förhandsvisning</h3><button class="btn" data-act="close">Stäng</button></div>
     <iframe class="artifact-frame" sandbox="allow-scripts" title="Förhandsvisning"></iframe>`
  );
  els.modalCard.classList.add("wide");
  const f = els.modalCard.querySelector(".artifact-frame");
  if (f) f.srcdoc = html;
  els.modalCard.querySelector('[data-act="close"]').onclick = closeModalSilently;
}

function uiPrompt(message, value = "") {
  return new Promise((resolve) => {
    openModal(
      `<h3>${escapeHtml(message)}</h3>
       <input id="ui-prompt-input" class="files-q" type="text" value="${escapeHtml(value)}" />
       <div class="modal-actions"><button class="btn" data-act="no">Avbryt</button><button class="btn primary" data-act="yes">Spara</button></div>`,
      { onClose: () => resolve(null) }
    );
    const input = els.modalCard.querySelector("#ui-prompt-input");
    input.focus(); input.select();
    const done = () => { const v = input.value.trim(); closeModalSilently(); resolve(v || null); };
    els.modalCard.querySelector('[data-act="no"]').onclick = () => { closeModalSilently(); resolve(null); };
    els.modalCard.querySelector('[data-act="yes"]').onclick = done;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(); } });
  });
}
function uiConfirm(message, { danger } = {}) {
  return new Promise((resolve) => {
    openModal(
      `<h3>Bekräfta</h3><p class="sub">${escapeHtml(message)}</p>
       <div class="modal-actions"><button class="btn" data-act="no">Avbryt</button><button class="btn ${danger ? "danger" : "primary"}" data-act="yes">${danger ? "Ta bort" : "OK"}</button></div>`,
      { onClose: () => resolve(false) }
    );
    els.modalCard.querySelector('[data-act="no"]').onclick = () => { closeModalSilently(); resolve(false); };
    els.modalCard.querySelector('[data-act="yes"]').onclick = () => { closeModalSilently(); resolve(true); };
  });
}

// Preview-and-confirm before sending an email on the user's behalf.
function confirmSend({ to, cc, subject, body }) {
  return new Promise((resolve) => {
    openModal(
      `<h3>Skicka mejl?</h3>
       <div class="hint" style="padding:2px 0"><b>Till:</b> ${escapeHtml(to || "")}${cc ? ` · <b>Kopia:</b> ${escapeHtml(cc)}` : ""}</div>
       ${subject ? `<div class="hint" style="padding:2px 0"><b>Ämne:</b> ${escapeHtml(subject)}</div>` : ""}
       <div class="bubble" style="max-height:42vh;overflow:auto;white-space:pre-wrap;margin-top:8px">${escapeHtml(body || "")}</div>
       <div class="modal-actions"><button class="btn" data-act="no">Avbryt</button><button class="btn primary" data-act="yes">Skicka</button></div>`,
      { onClose: () => resolve(false) }
    );
    els.modalCard.querySelector('[data-act="no"]').onclick = () => { closeModalSilently(); resolve(false); };
    els.modalCard.querySelector('[data-act="yes"]').onclick = () => { closeModalSilently(); resolve(true); };
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
     <div class="tabs" id="settings-tabs" role="tablist">
       <button class="tab active" data-tab="general">Allmänt</button>
       <button class="tab" data-tab="memory">Minne</button>
       <button class="tab" data-tab="chats">Chattar</button>
       <button class="tab" data-tab="workspace">Synk</button>
       <button class="tab" data-tab="schedules">Scheman</button>
     </div>

     <div class="tab-panel" data-panel="general">
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
         <div><div class="label">Modell</div><div class="hint">Drivs av Claude · enkla frågor körs snabbare automatiskt</div></div>
         <div class="setting-meta">${escapeHtml(modelName)}</div>
       </div>
     </div>

     <div class="tab-panel" data-panel="memory" hidden>
       <div class="setting-row" style="align-items:flex-start;border-top:none">
         <div><div class="label">Minne</div><div class="hint" id="memory-status">Vad Simba minns om dig – en rad per sak. ${escapeHtml(memoryStatusText())}</div></div>
         <div style="display:flex;gap:6px;flex:none">
           ${ssoServerConfigured && !signedIn ? `<button class="btn" id="memory-signin" style="padding:7px 12px">Logga in</button>` : ""}
           <button class="btn" id="memory-clear" style="padding:7px 12px">Rensa</button>
         </div>
       </div>
       <textarea id="memory-text" class="memory-text" rows="6" placeholder="Inget sparat än. Be Simba att minnas något, eller skriv här – en rad per sak.">${escapeHtml(memoryList().join("\n"))}</textarea>
     </div>

     <div class="tab-panel" data-panel="chats" hidden>
       <div class="setting-row" style="border-top:none">
         <div><div class="label">Konversationer</div><div class="hint">${signedIn ? "Dina chattar synkas mellan Excel, webb och dator" : "Logga in för att synka chattar mellan enheter"}</div></div>
         <div style="display:flex;gap:6px;flex:none">
           <button class="btn" id="export-chat" style="padding:7px 12px">Exportera</button>
           <button class="btn" id="settings-clear" style="padding:7px 12px">Ny chatt</button>
         </div>
       </div>
       ${signedIn ? '<div id="conv-list" class="conv-list"><div class="hint" style="padding:4px 2px">Laddar…</div></div>' : '<div class="hint" style="padding:2px">Logga in (fliken Minne) för att se sparade chattar.</div>'}
     </div>

     <div class="tab-panel" data-panel="workspace" hidden>
       <div class="setting-row" style="border-top:none">
         <div><div class="label">Arbetsutrymme</div><div class="hint">Delad arbetskontext som synkas mellan Excel, Outlook, webb och dator</div></div>
       </div>
       ${signedIn
          ? '<div id="ws-list" class="sched-list"><div class="hint" style="padding:4px 2px">Laddar…</div></div>'
          : '<div class="hint" style="padding:2px 2px 4px">Logga in med Microsoft för att synka arbetsutrymmet mellan dina appar. Be sedan Simba att spara t.ex. en tabell — så når du den i Outlook.</div>'}
     </div>

     <div class="tab-panel" data-panel="schedules" hidden>
       <div class="setting-row" style="border-top:none">
         <div><div class="label">Scheman</div><div class="hint">Automatiska jobb som körs åt dig${signedIn ? " – pausa eller ta bort här" : ""}</div></div>
       </div>
       ${signedIn
          ? '<div id="sched-list" class="sched-list"><div class="hint" style="padding:4px 2px">Laddar…</div></div>'
          : '<div class="hint" style="padding:2px 2px 4px">Logga in med Microsoft för att skapa och hantera scheman. Be sedan Simba, t.ex. "varje måndag 08:00, uppdatera rapporten".</div>'}
     </div>

     <div class="modal-actions">
       <button class="btn primary" data-act="done">Klar</button>
     </div>`
  );
  // Lazy-load each tab's data the first time it's shown.
  const loaded = { chats: false, schedules: false, workspace: false };
  const showTab = (name) => {
    els.modalCard.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    els.modalCard.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (name === "chats" && signedIn && !loaded.chats) { loaded.chats = true; populateConvList(); }
    if (name === "schedules" && signedIn && !loaded.schedules) { loaded.schedules = true; populateSchedules(); }
    if (name === "workspace" && signedIn && !loaded.workspace) { loaded.workspace = true; populateWorkspace(); }
  };
  els.modalCard.querySelector("#settings-tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (t) showTab(t.dataset.tab);
  });

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
  const signinBtn = els.modalCard.querySelector("#memory-signin");
  if (signinBtn) signinBtn.onclick = async () => {
    signinBtn.disabled = true;
    signinBtn.textContent = "Loggar in…";
    const ok = await initIdentity(true); // interactive: user asked, so a prompt is fine
    const status = els.modalCard.querySelector("#memory-status");
    if (status) status.textContent = `Vad Simba minns om dig – en rad per sak. ${memoryStatusText()}`;
    if (ok) {
      memoryTextEl.value = memoryList().join("\n");
      signinBtn.remove();
    } else {
      signinBtn.disabled = false;
      signinBtn.textContent = "Logga in";
      toast("Kunde inte logga in. Försök igen.", "error", 3000);
    }
  };
  els.modalCard.querySelector("#settings-clear").onclick = () => { resetChat(); closeModalSilently(); };
  els.modalCard.querySelector("#export-chat").onclick = exportChat;
  els.modalCard.querySelector('[data-act="done"]').onclick = () => { saveMemoryFromText(); closeModalSilently(); };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderMessage(role, text, opts) {
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
  const fileChip = opts?.file ? `<div class="msg-file">📎 ${escapeHtml(opts.file)}</div>` : "";
  const body = text ? `<div class="bubble">${formatMarkdown(text)}</div>` : "";
  wrap.innerHTML = `
    <div class="avatar">${role === "user" ? "🙂" : currentAvatar()}</div>
    <div class="body">${fileChip}${body}${actions}</div>`;
  els.messages.append(wrap);
  scrollDown();
}

/* A generated file (pptx/docx/xlsx/pdf) shown as a click-to-download card. The
 * base64 is decoded to a Blob and saved on the user's click (a user gesture, so
 * it works in the Office webview and the desktop app). */
function renderDownload(filename, base64, mediaType) {
  clearTyping();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML =
    `<div class="avatar">${MASCOT_IMG}</div>` +
    `<div class="body"><button class="dl-card" type="button">` +
    `<span class="dl-ic">⬇</span><span class="dl-name">${escapeHtml(filename)}</span>` +
    `<span class="dl-go">Ladda ner</span></button></div>`;
  wrap.querySelector(".dl-card").onclick = () => saveBase64(base64, filename, mediaType);
  els.messages.append(wrap);
  scrollDown();
}

// Export the current conversation as a Markdown file.
function exportChat() {
  if (!messages.length) { toast("Det finns inget att exportera ännu.", "info", 2000); return; }
  const lines = [`# Simba-chatt — ${new Date().toLocaleString("sv-SE")}`, ""];
  for (const m of messages) {
    if (m.role === "user") {
      const c = m.content;
      if (Array.isArray(c) && c.some((b) => b && b.type === "tool_result")) continue;
      let t = typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b) => b && b.type === "text")?.text || "") : "");
      t = t.replace(/\n\n\[Aktuell markering:[\s\S]*$/, "").replace(/^\[Agent:[^\]]*\][\s\S]*?\n\n/, "");
      if (t.trim()) lines.push("## Du", "", t.trim(), "");
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const t = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
      if (t) lines.push("## Simba", "", t, "");
    }
  }
  const b64 = btoa(unescape(encodeURIComponent(lines.join("\n"))));
  saveBase64(b64, `simba-chatt-${Date.now()}.md`, "text/markdown");
  toast("Exporterade chatten", "success", 1500);
}

function saveBase64(base64, filename, mediaType) {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mediaType || "application/octet-stream" }));
    const a = document.createElement("a");
    a.href = url; a.download = filename || "simba-fil";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch { toast("Kunde inte spara filen.", "error", 3000); }
}

/* Live streaming reply: show plain text as it arrives, then swap to rich
 * markdown (with code highlighting + hover actions) once the turn completes. */
function startStream() {
  clearTyping();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  wrap.innerHTML = `<div class="avatar">${currentAvatar()}</div><div class="body"><div class="bubble streaming"></div></div>`;
  els.messages.append(wrap);
  scrollDown();
  return { wrap, bubble: wrap.querySelector(".bubble"), text: "" };
}

function appendStream(live, chunk) {
  live.text += chunk;
  live.bubble.textContent = live.text;
  scrollDown();
}

function finishStream(live, fullText) {
  const text = (fullText || live.text || "").trim();
  live.wrap._raw = text;
  live.bubble.classList.remove("streaming");
  live.bubble.innerHTML = formatMarkdown(text);
  live.wrap.querySelector(".body").insertAdjacentHTML("beforeend",
    `<div class="msg-actions">` +
    `<button class="msg-act" data-act="copy" type="button" title="Kopiera svar" aria-label="Kopiera svar">⧉</button>` +
    `<button class="msg-act" data-act="regen" type="button" title="Generera om" aria-label="Generera om">↻</button>` +
    `</div>`);
  scrollDown();
}

function toolResultHint(name, input, result) {
  if (!result || result.error) return "";
  if (result.skipped) return "hoppades över";
  switch (name) {
    case "write_range": case "set_formula": case "set_formulas":
    case "format_range": case "select_range": return result.address || "";
    case "read_range": case "capture_view": return result.address || input?.address || "";
    case "create_table": return result.table || "";
    case "create_chart": return result.chart || "";
    case "add_sheet": return result.sheet || "";
    case "find": return typeof result.count === "number" ? `${result.count} träffar` : "";
    case "set_column_width": return result.width === "auto" ? "auto" : (result.width != null ? `${result.width} pt` : "");
    case "set_row_height": return result.height === "auto" ? "auto" : (result.height != null ? `${result.height} pt` : "");
    case "remember": return result.saved ? "sparat" : "";
    case "search_vault": return Array.isArray(result.entries) ? `${result.entries.length} träffar` : "";
    case "save_to_vault": return result.saved ? "sparat" : "";
    case "analyze_vault": return typeof result.count === "number" ? `${result.count} poster` : "";
    case "open_vault_file": return result.name || "";
    case "save_to_workspace": return result.saved ? "sparat" : "";
    case "get_workspace": return Array.isArray(result.items) ? `${result.items.length} objekt` : "";
    case "list_data_sources": return Array.isArray(result.sources) ? `${result.sources.length} datakällor` : "";
    case "query_data_source": return result.endpoint || "";
    case "run_code": return result.result ? "klart" : "";
    case "propose_plan": return result.approved ? "godkänd" : (result.approved === false ? "avböjd" : "");
    case "delegate_task": return typeof result.steps === "number" ? `${result.steps} steg` : "";
    case "schedule_task": return result.scheduled ? "schemalagt" : "";
    case "list_schedules": return Array.isArray(result.jobs) ? `${result.jobs.length} scheman` : "";
    case "cancel_schedule": return result.cancelled ? "borttaget" : "";
    case "list_files": return Array.isArray(result.files) ? `${result.files.length} filer` : "";
    case "open_file": return result.name || "";
    case "list_emails": return Array.isArray(result.messages) ? `${result.messages.length} mejl` : "";
    case "read_email": return result.message?.subject || "";
    case "read_current_email": return result.subject || (result.error ? "" : "öppet mejl");
    case "send_email": return result.sent ? "skickat" : (result.skipped ? "avbrutet" : "");
    case "create_document": return result.filename || "";
    case "find_errors": return typeof result.count === "number" ? `${result.count} fel` : "";
    case "conditional_formatting": case "data_validation": case "add_comment": return result.address || input?.address || "";
    case "create_pivot_table": return result.pivot || "";
    case "apply_filter": return result.filtered ? "filtrerat" : (result.applied ? "filter på" : "");
    case "remove_duplicates": return typeof result.removed === "number" ? `${result.removed} borttagna` : "";
    case "create_named_range": return result.name || input?.name || "";
    case "describe_workbook": return typeof result.sheetCount === "number" ? `${result.sheetCount} blad` : "";
    case "trace_cell": return Array.isArray(result.precedents) || Array.isArray(result.dependents)
      ? `${(result.precedents || []).length} in, ${(result.dependents || []).length} ut` : "";
    case "list_charts": return Array.isArray(result.charts) ? `${result.charts.length} diagram` : "";
    case "update_chart": return result.name || input?.name || "";
    default: return result.address || "";
  }
}

function toolLabel(name, input) {
  const labels = {
    get_selection: "Läser din markering",
    read_range: `Läser ${input?.address || "ett område"}`,
    get_sheet_info: "Granskar arket",
    list_sheets: "Tittar på arbetsboken",
    describe_workbook: "Kartlägger hela arbetsboken",
    trace_cell: `Spårar beroenden för ${input?.address || "en cell"}`,
    list_charts: "Letar efter diagram",
    find: `Söker efter "${input?.query || ""}"`,
    capture_view: `Tittar på ${input?.address || "arket"}`,
    analyze_data: `Analyserar ${input?.address || "data"}`,
    web_lookup: `Söker på webben: "${input?.query || ""}"`,
    run_code: "Kör kod",
    create_document: `Skapar ${(input?.kind || "dokument").toUpperCase()}`,
    list_files: input?.query ? `Letar efter "${input.query}" i dina filer` : "Letar i dina filer",
    open_file: `Öppnar ${input?.name || "fil"}`,
    list_emails: input?.query ? `Söker i mejlen: "${input.query}"` : "Läser din inkorg",
    read_email: "Öppnar ett mejl",
    read_current_email: "Läser det öppna mejlet",
    send_email: "Skickar ett mejl",
    schedule_task: input?.name ? `Schemalägger: ${input.name}` : "Skapar ett schema",
    list_schedules: "Hämtar dina scheman",
    cancel_schedule: "Tar bort ett schema",
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
    search_vault: input?.query ? `Söker i kunskapsbanken: "${input.query}"` : "Söker i kunskapsbanken",
    save_to_vault: "Sparar i kunskapsbanken",
    analyze_vault: "Analyserar kunskapsbanken",
    open_vault_file: "Öppnar en bilaga ur kunskapsbanken",
    save_to_workspace: "Sparar i arbetsutrymmet",
    get_workspace: "Hämtar arbetsutrymmet",
    list_data_sources: "Letar efter datakällor",
    query_data_source: input?.endpoint ? `Hämtar data: ${input.source || ""}/${input.endpoint}` : "Hämtar data från ekonomisystem",
    propose_plan: "Gör upp en plan",
    delegate_task: input?.task ? `Delegerar: ${String(input.task).slice(0, 40)}` : "Delegerar en deluppgift",
    find_errors: "Söker efter formelfel",
    conditional_formatting: `Villkorsformaterar ${input?.address || "ett område"}`,
    data_validation: `Lägger till rullgardin i ${input?.address || "ett område"}`,
    add_comment: `Kommenterar ${input?.address || "en cell"}`,
    create_pivot_table: `Skapar en pivottabell från ${input?.source_range || "data"}`,
    apply_filter: `Filtrerar ${input?.address || "ett område"}`,
    remove_duplicates: `Tar bort dubbletter i ${input?.address || "ett område"}`,
    create_named_range: `Namnger ${input?.address || "ett område"}${input?.name ? ` som "${input.name}"` : ""}`,
    create_table: `Skapar en tabell från ${input?.address || "ett område"}`,
    create_chart: "Skapar ett diagram",
    update_chart: `Förbättrar diagrammet${input?.name ? ` "${input.name}"` : ""}`,
    add_sheet: "Lägger till ett blad",
    select_range: `Markerar ${input?.address || "ett område"}`,
    revert_last_change: "Ångrar senaste ändringen",
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
    <div class="avatar">${currentAvatar()}</div>
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

function markStepDone(group, step, isError, hint) {
  step.classList.remove("running");
  step.classList.add(isError ? "error" : "done");
  step.querySelector(".tg-step-ic").textContent = isError ? "!" : "✓";
  if (hint) {
    const meta = document.createElement("span");
    meta.className = "tg-step-meta";
    meta.textContent = hint;
    step.append(meta);
  }
  group.done++;
}

function finalizeToolGroup(group) {
  if (!group) return;
  const n = group.count;
  group.titleEl.textContent = n === 1 ? "1 åtgärd utförd" : `${n} åtgärder utförda`;
  group.countEl.textContent = String(n);
  group.countEl.hidden = false;
  group.icEl.innerHTML = '<span class="tg-check">✓</span>';
  group.card.classList.add("done");              // stops the running shimmer
  group.card.classList.remove("open");           // collapse to a tidy summary
  group.card.querySelector(".tg-head")?.setAttribute("aria-expanded", "false");
}

function renderTyping() {
  clearTyping();
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = `<div class="avatar">${currentAvatar()}</div><div class="body"><div class="bubble">
    <span class="typing"><span></span><span></span><span></span></span></div></div>`;
  els.messages.append(el);
  activeTyping = el;
  scrollDown();
  return el;
}

function clearTyping() {
  if (activeTyping) { activeTyping.remove(); activeTyping = null; }
}

/* ---- File attachments (user-initiated; the add-in sandbox can't browse the
 * disk, but the user can attach a file and Simba reads it) ---------------- */
const ATTACH_MAX_BYTES = 5 * 1024 * 1024;       // 5 MB
const ATTACH_TEXT_MAX = 200_000;                 // chars of text content kept

function readFile(file, asDataUrl) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error("Kunde inte läsa filen."));
    fr.onload = () => resolve(fr.result);
    asDataUrl ? fr.readAsDataURL(file) : fr.readAsText(file);
  });
}

async function handleAttach(file) {
  if (pendingAttachments.length >= MAX_ATTACH) { toast(`Max ${MAX_ATTACH} filer åt gången.`, "info", 2500); return; }
  if (file.size > ATTACH_MAX_BYTES) { toast("Filen är för stor (max 5 MB).", "error", 3500); return; }
  const name = file.name || "fil";
  const type = file.type || "";
  const isText = /^text\//.test(type) || /\.(csv|tsv|txt|md|json|tab)$/i.test(name);
  try {
    let att = null;
    if (type === "application/pdf" || /\.pdf$/i.test(name)) {
      const data = (await readFile(file, true)).split(",")[1];
      att = { name, kind: "PDF", block: { type: "document", source: { type: "base64", media_type: "application/pdf", data } } };
    } else if (/^image\/(png|jpeg|gif|webp)$/.test(type)) {
      const data = (await readFile(file, true)).split(",")[1];
      att = { name, kind: "bild", block: { type: "image", source: { type: "base64", media_type: type, data } } };
    } else if (/^image\//.test(type)) {
      toast("Bildformatet stöds inte (använd PNG, JPG, GIF eller WebP).", "error", 3500);
      return;
    } else if (isText) {
      let text = await readFile(file, false);
      if (text.length > ATTACH_TEXT_MAX) text = text.slice(0, ATTACH_TEXT_MAX) + "\n…(avkortad)";
      att = { name, kind: "text", block: { type: "text", text: `Bifogad fil "${name}":\n\n${text}` } };
    } else {
      toast("Filtypen stöds inte (CSV, text, bild eller PDF).", "error", 3500);
      return;
    }
    pendingAttachments.push(att);
    renderAttachChip();
  } catch (e) {
    toast(e.message || "Kunde inte läsa filen.", "error", 3500);
  }
}

function renderAttachChip() {
  if (!pendingAttachments.length) { els.attachChip.hidden = true; els.attachChip.innerHTML = ""; return; }
  els.attachChip.hidden = false;
  els.attachChip.innerHTML = pendingAttachments.map((a, i) =>
    `<span class="attach-pill"><span class="ac-ic">📎</span><span class="ac-name">${escapeHtml(a.name)}</span>` +
    `<span class="ac-kind">${a.kind}</span>` +
    `<button class="ac-x" type="button" data-i="${i}" title="Ta bort" aria-label="Ta bort bilaga">×</button></span>`).join("");
  els.attachChip.querySelectorAll(".ac-x").forEach((b) => b.onclick = () => removeAttachment(+b.dataset.i));
}

function removeAttachment(i) {
  pendingAttachments.splice(i, 1);
  renderAttachChip();
}
function clearAttachment() {
  pendingAttachments = [];
  renderAttachChip();
}

/* After a turn finishes, drop the heavy base64 (attached/opened images & PDFs,
 * captured screenshots) from the conversation history so it isn't re-uploaded on
 * every later turn — keeps requests small and the chat continuable. The model
 * already saw them during the turn; it can re-open/re-capture if needed. */
function pruneHeavyHistory() {
  const lighten = (b) => {
    if (!b || typeof b !== "object") return b;
    if ((b.type === "image" || b.type === "document") && b.source?.data)
      return { type: "text", text: b.type === "image" ? "(bild – borttagen ur historiken)" : "(dokument – borttaget ur historiken)" };
    if (b.type === "tool_result" && Array.isArray(b.content)) return { ...b, content: b.content.map(lighten) };
    return b;
  };
  for (const m of messages) if (Array.isArray(m.content)) m.content = m.content.map(lighten);
}

/** Markdown: fenced code (with header), headings, lists, links, quotes, hr, inline. */
function formatMarkdown(text) {
  const blocks = [];
  const src = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const label = (lang || "").toLowerCase();
    const raw = code.replace(/\n+$/, "");
    const previewable = label === "html" || label === "svg" || (label === "xml" && /<svg/i.test(raw));
    const previewBtn = previewable
      ? `<button class="preview-btn" type="button" data-code="${btoa(unescape(encodeURIComponent(raw)))}">Förhandsgranska</button>`
      : "";
    const html =
      `<div class="codeblock">` +
        `<div class="cb-head"><span class="cb-lang">${escapeHtml(label || "kod")}</span>` +
        `<span class="cb-acts">${previewBtn}<button class="copy-btn" type="button">Kopiera</button></span></div>` +
        `<pre><code>${highlight(raw, lang)}</code></pre>` +
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
  // While working, the send button becomes a Stop button (never disabled).
  els.send.disabled = false;
  els.send.classList.toggle("stop", state);
  els.send.title = state ? "Stoppa" : "Skicka";
  els.send.setAttribute("aria-label", state ? "Stoppa" : "Skicka");
  els.send.innerHTML = state ? "◼" : "➤";
  els.prompt.disabled = state;
}

// A brief happy wag of the header mascot when Simba finishes a reply.
function cheerMascot() {
  const el = document.querySelector(".brand-mark");
  if (!el) return;
  el.classList.remove("cheer");
  void el.offsetWidth; // restart the animation
  el.classList.add("cheer");
  setTimeout(() => el.classList.remove("cheer"), 800);
}

// User-initiated stop: abort the in-flight request and let the loop bail cleanly.
function stopGeneration() {
  stopRequested = true;
  try { activeController?.abort(); } catch { /* ignore */ }
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
  document.body.classList.add("has-chat"); // let the mascot watermark recede
}

function resetChat() {
  if (busy) { toast("Vänta lite — Simba arbetar fortfarande.", "info"); return; }
  messages = [];
  els.messages.innerHTML = welcomeHTML();
  bindSuggestions();
  document.body.classList.remove("has-chat"); // bring the welcome + watermark back
  if (signedIn) {
    conversationId = null; // a fresh server conversation is created on first save
  }
}

/* ---- Shared conversation history (synced per user across devices) -------- */
let conversationId = null;
let convSaveTimer = null;

function convTitle() {
  for (const m of messages) {
    if (m.role !== "user") continue;
    let t = typeof m.content === "string" ? m.content
      : Array.isArray(m.content) ? (m.content.find((b) => b && b.type === "text")?.text || "") : "";
    t = t.replace(/\n\n\[Aktuell markering:[\s\S]*$/, "").trim();
    if (t) return t.slice(0, 60);
  }
  return "Ny chatt";
}

async function loadConversations() {
  if (!signedIn) return;
  try {
    const token = await getSsoToken(false);
    if (!token) return;
    const r = await fetch(`${API_BASE}/api/conversations`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const { conversations } = await r.json();
    if (Array.isArray(conversations) && conversations.length && !messages.length) {
      await openConversation(conversations[0].id); // resume the most recent
    }
    refreshSidebar(); // populate the standalone sidebar once signed in
  } catch { /* stay local */ }
}

async function openConversation(id) {
  try {
    const token = await getSsoToken(false);
    if (!token) return;
    const r = await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const c = await r.json();
    conversationId = c.id;
    messages = Array.isArray(c.messages) ? c.messages : [];
    renderHistory(messages);
    refreshSidebar();
  } catch { /* ignore */ }
}

function saveConversation() {
  if (!signedIn || !messages.length) return;
  clearTimeout(convSaveTimer);
  convSaveTimer = setTimeout(async () => {
    try {
      const token = await getSsoToken(false);
      if (!token) return;
      if (!conversationId) {
        const r = await fetch(`${API_BASE}/api/conversations`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ title: convTitle(), messages }),
        });
        if (r.ok) { conversationId = (await r.json()).id; refreshSidebar(); }
        return;
      }
      await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ title: convTitle(), messages }),
      });
      refreshSidebar();
    } catch { /* best effort */ }
  }, 800);
}

async function fetchConvList() {
  try {
    const token = await getSsoToken(false);
    if (!token) return null;
    const r = await fetch(`${API_BASE}/api/conversations`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? ((await r.json()).conversations || []) : null;
  } catch { return null; }
}

function renderConvInto(el, list, limit, afterPick) {
  if (!el) return;
  if (list === null) { el.innerHTML = '<div class="hint" style="padding:6px 4px">Kunde inte hämta chattar.</div>'; return; }
  if (!list.length) { el.innerHTML = '<div class="hint" style="padding:6px 4px">Inga sparade chattar än.</div>'; return; }
  el.innerHTML = list.slice(0, limit).map((c) =>
    `<div class="conv-row${c.id === conversationId ? " active" : ""}" data-id="${escapeHtml(c.id)}">
       <button class="conv-item" data-id="${escapeHtml(c.id)}" title="${escapeHtml(c.title || "Namnlös chatt")}">${escapeHtml(c.title || "Namnlös chatt")}</button>
       <div class="conv-acts">
         <button class="conv-act" data-act="rename" title="Byt namn" aria-label="Byt namn">✎</button>
         <button class="conv-act" data-act="del" title="Ta bort" aria-label="Ta bort">🗑</button>
       </div>
     </div>`).join("");
  el.querySelectorAll(".conv-row").forEach((row) => {
    const id = row.dataset.id;
    const title = list.find((c) => c.id === id)?.title || "";
    row.querySelector(".conv-item").addEventListener("click", async () => { await openConversation(id); afterPick?.(); });
    row.querySelector('[data-act="rename"]').addEventListener("click", (e) => { e.stopPropagation(); convRename(id, title); });
    row.querySelector('[data-act="del"]').addEventListener("click", (e) => { e.stopPropagation(); convDelete(id); });
  });
}

async function convRename(id, currentTitle) {
  const name = await uiPrompt("Byt namn på chatten", currentTitle || "");
  if (name == null) return;
  const token = await getSsoToken(false);
  if (!token) return;
  await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ title: name }), // no messages → title-only rename
  }).catch(() => {});
  refreshSidebar();
  if (els.modalCard?.querySelector("#conv-list")) populateConvList();
  toast("Chatten döptes om", "success", 1500);
}

async function convDelete(id) {
  const ok = await uiConfirm("Ta bort den här chatten? Det går inte att ångra.", { danger: true });
  if (!ok) return;
  const token = await getSsoToken(false);
  if (!token) return;
  await fetch(`${API_BASE}/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  if (id === conversationId) resetChat(); // we deleted the open one
  refreshSidebar();
  if (els.modalCard?.querySelector("#conv-list")) populateConvList();
  toast("Chatten togs bort", "success", 1500);
}

async function populateConvList() {
  const el = els.modalCard.querySelector("#conv-list");
  if (!el) return;
  renderConvInto(el, await fetchConvList(), 12, closeModalSilently);
}

/* ---- Scheduled jobs management UI -------------------------------------- */
const WEEKDAY_SV = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
function scheduleSummary(s = {}) {
  const t = s.time || "";
  const freq = {
    daily: "Varje dag",
    weekdays: "Vardagar",
    weekly: `Varje ${WEEKDAY_SV[s.weekday ?? 1] || "vecka"}`,
    monthly: `Dag ${s.monthday ?? 1} varje månad`,
    once: `En gång${s.onDate ? ` ${s.onDate}` : ""}`,
  }[s.freq] || s.freq || "";
  return `${freq}${t ? ` kl. ${t}` : ""}`.trim();
}
function nextRunText(ms) {
  if (!ms) return "";
  try { return new Date(ms).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }); }
  catch { return ""; }
}
async function jobSetEnabled(id, enabled) {
  const token = await getSsoToken(false);
  if (!token) return;
  await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(id)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled }),
  }).catch(() => {});
}
async function jobDelete(id) {
  const token = await getSsoToken(false);
  if (!token) return;
  await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}
async function populateSchedules() {
  const el = els.modalCard.querySelector("#sched-list");
  if (!el) return;
  const hint = (t) => `<div class="hint" style="padding:4px 2px">${t}</div>`;
  try {
    const token = await getSsoToken(false);
    const r = token && await fetch(`${API_BASE}/api/jobs`, { headers: { Authorization: `Bearer ${token}` } });
    const data = r && r.ok ? await r.json() : null;
    if (!data) { el.innerHTML = hint("Kunde inte hämta scheman."); return; }
    const jobs = data.jobs || [];
    const note = data.schedulerEnabled ? "" : hint("Schemaläggaren är avstängd på servern – jobb sparas men körs inte än.");
    if (!jobs.length) { el.innerHTML = note + hint('Inga scheman än. Be Simba, t.ex. "varje måndag 08:00, uppdatera rapporten".'); return; }
    el.innerHTML = note + jobs.map((j) => `
      <div class="sched-item" data-id="${escapeHtml(j.id)}" data-enabled="${j.enabled ? 1 : 0}">
        <div class="sched-main">
          <div class="sched-name">${j.enabled ? "" : "⏸ "}${escapeHtml(j.name || "Schema")}</div>
          <div class="sched-meta">${escapeHtml(scheduleSummary(j.schedule))}${j.target?.fileName ? ` · ${escapeHtml(j.target.fileName)}` : ""}${j.target?.notify ? " · 📧" : ""}${j.nextRun ? ` · nästa ${escapeHtml(nextRunText(j.nextRun))}` : ""}</div>
          ${j.lastStatus ? `<div class="sched-meta">Senast: ${escapeHtml(j.lastStatus)}${j.lastResult ? ` – ${escapeHtml(String(j.lastResult).slice(0, 90))}` : ""}</div>` : ""}
        </div>
        <div class="sched-acts">
          <button class="btn" data-act="toggle" style="padding:5px 10px">${j.enabled ? "Pausa" : "Återuppta"}</button>
          <button class="msg-act" data-act="del" title="Ta bort schema" aria-label="Ta bort">🗑</button>
        </div>
      </div>`).join("");
    el.querySelectorAll(".sched-item").forEach((item) => {
      const id = item.dataset.id;
      item.querySelector('[data-act="toggle"]').onclick = async () => { await jobSetEnabled(id, item.dataset.enabled !== "1"); populateSchedules(); };
      item.querySelector('[data-act="del"]').onclick = async () => { await jobDelete(id); populateSchedules(); };
    });
  } catch { el.innerHTML = hint("Kunde inte hämta scheman."); }
}

// Settings → Synk: the shared workspace (cross-surface working context).
async function populateWorkspace() {
  const el = els.modalCard.querySelector("#ws-list");
  if (!el) return;
  const hint = (t) => `<div class="hint" style="padding:4px 2px">${t}</div>`;
  try {
    const token = await getSsoToken(false);
    const r = token && await fetch(`${API_BASE}/api/workspace`, { headers: { Authorization: `Bearer ${token}` } });
    const j = r && r.ok ? await r.json() : null;
    if (!j) { el.innerHTML = hint("Kunde inte hämta arbetsutrymmet."); return; }
    const items = j.items || [];
    if (!items.length) { el.innerHTML = hint('Tomt än. Be Simba spara något här, t.ex. "spara den här tabellen i arbetsutrymmet" i Excel — sen når du den i Outlook.'); return; }
    el.innerHTML = items.map((it) => `
      <div class="sched-item" data-id="${escapeHtml(it.id)}">
        <div class="sched-main">
          <div class="sched-name">${escapeHtml(it.label || "Notis")}${it.source ? ` <span class="vault-count">${escapeHtml(it.source)}</span>` : ""}</div>
          <div class="sched-meta">${escapeHtml(String(it.content || "").replace(/\s+/g, " ").slice(0, 120))}</div>
        </div>
        <div class="sched-acts"><button class="msg-act" data-act="del" title="Ta bort" aria-label="Ta bort">🗑</button></div>
      </div>`).join("");
    el.querySelectorAll(".sched-item").forEach((item) => {
      item.querySelector('[data-act="del"]').onclick = async () => {
        const t = await getSsoToken(false);
        await fetch(`${API_BASE}/api/workspace/${encodeURIComponent(item.dataset.id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
        populateWorkspace();
      };
    });
  } catch { el.innerHTML = hint("Kunde inte nå arbetsutrymmet."); }
}

/* ---- Command palette (⌘K) ---------------------------------------------- */
function commandList() {
  const cmds = [
    { icon: "＋", label: "Ny chatt", run: () => resetChat() },
    { icon: "✦", label: "Agenter", run: () => openAgents() },
    { icon: "⚙", label: "Inställningar", run: () => openSettings() },
    { icon: "📤", label: "Exportera chatt", run: () => exportChat() },
    { icon: "🎨", label: "Växla tema (ljust/mörkt)", run: () => {
      const next = (document.documentElement.getAttribute("data-theme") === "dark") ? "light" : "dark";
      applyTheme(next); store.set("simba.theme", next);
    } },
  ];
  if (ssoServerConfigured) cmds.splice(3, 0, { icon: "📚", label: "Kunskapsbank", run: () => openVault() });
  if (ssoServerConfigured) cmds.splice(4, 0, { icon: "📧", label: "E-post", run: () => openMail() });
  if (ssoServerConfigured) cmds.splice(5, 0, { icon: "🔌", label: "Datakällor (ekonomisystem)", run: () => openConnectors() });
  if (ssoServerConfigured) cmds.splice(5, 0, { icon: "☁", label: "Molnfiler", run: () => openFilesBrowser() });
  if (busy) cmds.unshift({ icon: "◼", label: "Stoppa Simba", run: () => stopGeneration() });
  return cmds;
}

function openCommandPalette() {
  const cmds = commandList();
  openModal(
    `<input id="cmd-q" class="files-q" type="search" placeholder="Skriv ett kommando…" autocomplete="off" style="margin-top:0" />
     <div id="cmd-list" class="files-list"></div>`
  );
  const qEl = els.modalCard.querySelector("#cmd-q");
  const listEl = els.modalCard.querySelector("#cmd-list");
  let view = cmds;
  const render = () => {
    listEl.innerHTML = view.map((c, i) =>
      `<button class="file-item${i === 0 ? " active" : ""}" data-i="${i}"><span class="file-ic">${c.icon}</span><span class="file-main"><span class="file-name">${escapeHtml(c.label)}</span></span></button>`).join("")
      || '<div class="hint" style="padding:6px 2px">Inget matchar.</div>';
    listEl.querySelectorAll(".file-item").forEach((b) =>
      b.addEventListener("click", () => { const c = view[+b.dataset.i]; closeModalSilently(); c?.run(); }));
  };
  const run = (c) => { closeModalSilently(); c?.run(); };
  qEl.addEventListener("input", () => {
    const q = qEl.value.trim().toLowerCase();
    view = q ? cmds.filter((c) => c.label.toLowerCase().includes(q)) : cmds;
    render();
  });
  qEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && view[0]) { e.preventDefault(); run(view[0]); } });
  render();
  qEl.focus();
}

/* ---- Specialist agents (side panel) ------------------------------------ */
function openAgents() {
  const cards = AGENTS.map((a) => `
    <button class="agent-card${activeAgent?.id === a.id ? " active" : ""}" data-id="${a.id}">
      <span class="agent-ic">${a.icon}</span>
      <span class="agent-meta"><span class="agent-name">${escapeHtml(a.name)}</span>
      <span class="agent-blurb">${escapeHtml(a.blurb)}</span></span>
    </button>`).join("");
  openModal(
    `<h3>Agenter</h3>
     <p class="sub">Specialiserade hjälpare som styr Simba mot en sorts arbete. Välj en — den gäller tills du stänger av den.</p>
     <div class="agent-grid">${cards}</div>
     <div class="modal-actions">
       ${activeAgent ? '<button class="btn" id="agent-off">Stäng av agent</button>' : ""}
       <button class="btn primary" data-act="cancel">Klar</button>
     </div>`
  );
  els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
  const off = els.modalCard.querySelector("#agent-off");
  if (off) off.onclick = () => { setActiveAgent(null); closeModalSilently(); };
  els.modalCard.querySelectorAll(".agent-card").forEach((b) =>
    b.addEventListener("click", () => {
      const a = AGENTS.find((x) => x.id === b.dataset.id);
      setActiveAgent(activeAgent?.id === a.id ? null : a); // tap again to toggle off
      closeModalSilently();
    }));
}

function setActiveAgent(agent) {
  activeAgent = agent;
  renderAgentChip();
  if (agent) {
    if (els.prompt) els.prompt.placeholder = `${agent.icon} ${agent.name}: vad vill du göra?`;
    els.prompt?.focus();
    toast(`${agent.icon} ${agent.name}-agenten är aktiv`, "info", 1800);
  } else if (els.prompt) {
    els.prompt.placeholder = IS_EXCEL ? "Fråga Simba om ditt kalkylark…" : "Fråga Simba vad som helst…";
  }
  els.agents?.classList.toggle("on", !!agent);
}

function renderAgentChip() {
  if (!els.agentChip) return;
  if (!activeAgent) { els.agentChip.hidden = true; els.agentChip.innerHTML = ""; return; }
  els.agentChip.hidden = false;
  els.agentChip.innerHTML =
    `<span class="ac-ic">${activeAgent.icon}</span><span class="ac-name">${escapeHtml(activeAgent.name)}-agent</span>` +
    `<button class="ac-x" type="button" title="Stäng av agent" aria-label="Stäng av agent">×</button>`;
  els.agentChip.querySelector(".ac-x").onclick = () => setActiveAgent(null);
}

// A banner that announces the specialist sub-agent picking up the turn.
function renderAgentRun(agent) {
  clearTyping();
  const el = document.createElement("div");
  el.className = "agent-run";
  el.innerHTML =
    `<span class="agent-run-ic">${agent.icon}</span>` +
    `<span class="agent-run-txt"><b>${escapeHtml(agent.name)}-agenten</b> tar över och arbetar…</span>`;
  els.messages.append(el);
  scrollDown();
}

/* ---- Company knowledge vault (Simba's shared mind) --------------------- */
let vaultCanWrite = false;
let vaultView = "list";   // "list" | "map"
let vaultEntries = [];    // cached for the map view + filtering
let mailFolder = "inbox"; // inbox | sentitems | drafts | archive
async function openVault() {
  const token = await getSsoToken(false);
  if (!token) {
    openModal(
      `<h3>Kunskapsbank</h3><p class="sub">Logga in med Microsoft för att se företagets delade kunskapsbank.</p>
       <div class="modal-actions"><button class="btn" data-act="cancel">Avbryt</button><button class="btn primary" id="vault-signin">Logga in</button></div>`
    );
    els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
    els.modalCard.querySelector("#vault-signin").onclick = async () => { if (await initIdentity(true)) openVault(); else toast("Kunde inte logga in.", "error", 3000); };
    return;
  }
  openModal(
    `<div class="vault-head">
       <div><h3 style="margin:0">Kunskapsbank</h3><p class="sub" style="margin:2px 0 0">Företagets delade minne — Simba grundar sina svar i detta i varje session.</p></div>
       <div style="display:flex;gap:6px;flex:none">
         <button class="btn" id="vault-analyze" style="padding:7px 12px">Analysera</button>
         <button class="btn primary" id="vault-new" style="padding:7px 12px">＋ Ny</button>
       </div>
     </div>
     <div class="tabs" id="vault-tabs" style="margin-bottom:10px">
       <button class="tab active" data-v="list">Lista</button>
       <button class="tab" data-v="map">Karta</button>
     </div>
     <input id="vault-q" class="files-q" type="search" placeholder="Sök (semantiskt + nyckelord)…" autocomplete="off" />
     <div id="vault-list" class="vault-list"><div class="hint" style="padding:6px 2px">Laddar…</div></div>
     <div class="modal-actions"><button class="btn" data-act="cancel">Stäng</button></div>`
  );
  els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
  els.modalCard.querySelector("#vault-new").onclick = () => vaultEdit(null);
  els.modalCard.querySelector("#vault-analyze").onclick = analyzeVaultUI;
  const qEl = els.modalCard.querySelector("#vault-q");
  let deb;
  qEl.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => loadVault(qEl.value.trim()), 300); });
  els.modalCard.querySelector("#vault-tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab");
    if (!t) return;
    els.modalCard.querySelectorAll("#vault-tabs .tab").forEach((x) => x.classList.toggle("active", x === t));
    vaultView = t.dataset.v;
    qEl.style.display = vaultView === "map" ? "none" : "";
    if (vaultView === "map") renderVaultMap(); else loadVault(qEl.value.trim());
  });
  loadVault("");
}

async function loadVault(query) {
  const listEl = els.modalCard.querySelector("#vault-list");
  if (!listEl) return;
  listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Söker…</div>';
  try {
    const token = await getSsoToken(false);
    const r = await fetch(`${API_BASE}/api/vault?q=${encodeURIComponent(query || "")}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { listEl.innerHTML = `<div class="hint" style="padding:6px 2px">${escapeHtml(j.error || "Kunde inte hämta.")}</div>`; return; }
    vaultCanWrite = !!j.canWrite;
    vaultEntries = j.entries || [];
    const newBtn = els.modalCard.querySelector("#vault-new");
    if (newBtn) newBtn.hidden = !vaultCanWrite;
    if (vaultView === "map") { renderVaultMap(); return; }
    if (!vaultEntries.length) {
      listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Tomt än. Lägg till företagets fakta, policys, dokument och definitioner så minns Simba dem överallt.</div>';
      return;
    }
    const byTopic = {};
    for (const e of vaultEntries) (byTopic[e.topic] = byTopic[e.topic] || []).push(e);
    listEl.innerHTML = Object.keys(byTopic).sort().map((topic) =>
      `<div class="vault-topic"><div class="vault-topic-h">${escapeHtml(topic)} <span class="vault-count">${byTopic[topic].length}</span></div>` +
      byTopic[topic].map((e) => `
        <div class="vault-item" data-id="${escapeHtml(e.id)}">
          <div class="vault-main"><div class="vault-title">${e.file ? "📎 " : ""}${escapeHtml(e.title)}</div>
          <div class="vault-snip">${escapeHtml(String(e.content).slice(0, 140))}</div></div>
          <div class="vault-acts">${e.file ? `<button class="conv-act" data-act="open" title="Öppna bilaga">📄</button>` : ""}${vaultCanWrite ? `<button class="conv-act" data-act="edit" title="Redigera">✎</button><button class="conv-act" data-act="del" title="Ta bort">🗑</button>` : ""}</div>
        </div>`).join("") + `</div>`).join("");
    listEl.querySelectorAll(".vault-item").forEach((it) => {
      const id = it.dataset.id;
      const entry = vaultEntries.find((e) => e.id === id);
      it.querySelector('[data-act="open"]')?.addEventListener("click", () => openVaultFilePreview(id, entry));
      it.querySelector('[data-act="edit"]')?.addEventListener("click", () => vaultEdit(entry));
      it.querySelector('[data-act="del"]')?.addEventListener("click", async () => {
        if (!(await uiConfirm(`Ta bort "${entry.title}" ur kunskapsbanken?`, { danger: true }))) { openVault(); return; }
        const t = await getSsoToken(false);
        await fetch(`${API_BASE}/api/vault/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
        openVault();
      });
    });
  } catch { listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Kunde inte nå kunskapsbanken.</div>'; }
}

// A radial mind map: the company at the centre, topics as branches sized by
// how much they hold. Click a branch to filter the list to it.
function renderVaultMap() {
  const listEl = els.modalCard.querySelector("#vault-list");
  if (!listEl) return;
  const byTopic = {};
  for (const e of vaultEntries) (byTopic[e.topic] = byTopic[e.topic] || []).push(e);
  const topics = Object.keys(byTopic).sort();
  if (!topics.length) { listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Inget att kartlägga än.</div>'; return; }
  const W = 600, H = 420, cx = W / 2, cy = H / 2, R = 150;
  const nodes = topics.map((t, i) => {
    const a = (i / topics.length) * Math.PI * 2 - Math.PI / 2;
    const n = byTopic[t].length;
    return { t, n, x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, r: Math.max(20, Math.min(40, 16 + n * 3)) };
  });
  const lines = nodes.map((n) => `<line x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}" stroke="var(--border-strong)" stroke-width="1.5"/>`).join("");
  const blobs = nodes.map((n) => `
    <g class="vm-node" data-topic="${escapeHtml(n.t)}" style="cursor:pointer">
      <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r}" fill="var(--accent-tint)" stroke="var(--accent)" stroke-width="1.5"/>
      <text x="${n.x.toFixed(1)}" y="${(n.y - 1).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink)">${escapeHtml(n.t.slice(0, 12))}</text>
      <text x="${n.x.toFixed(1)}" y="${(n.y + 12).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--accent-strong)">${n.n}</text>
    </g>`).join("");
  listEl.innerHTML =
    `<svg class="vault-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kunskapskarta">
       ${lines}
       <circle cx="${cx}" cy="${cy}" r="46" fill="var(--accent)"/>
       <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">Företaget</text>
       <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10" fill="#fff" opacity="0.85">${vaultEntries.length} poster</text>
       ${blobs}
     </svg>`;
  listEl.querySelectorAll(".vm-node").forEach((g) => g.addEventListener("click", () => {
    // Switch to the list filtered to this branch.
    vaultView = "list";
    els.modalCard.querySelectorAll("#vault-tabs .tab").forEach((x) => x.classList.toggle("active", x.dataset.v === "list"));
    const qEl = els.modalCard.querySelector("#vault-q");
    qEl.style.display = ""; qEl.value = "";
    const topic = g.dataset.topic;
    const saved = vaultEntries;
    vaultEntries = saved.filter((e) => e.topic === topic);
    // reuse list rendering with the filtered set
    const tmp = vaultEntries; vaultEntries = tmp; renderFilteredList();
  }));
}
function renderFilteredList() {
  const listEl = els.modalCard.querySelector("#vault-list");
  if (!listEl) return;
  listEl.innerHTML = vaultEntries.map((e) => `
    <div class="vault-item" data-id="${escapeHtml(e.id)}">
      <div class="vault-main"><div class="vault-title">${e.file ? "📎 " : ""}${escapeHtml(e.title)}</div>
      <div class="vault-snip">[${escapeHtml(e.topic)}] ${escapeHtml(String(e.content).slice(0, 140))}</div></div>
      <div class="vault-acts">${e.file ? `<button class="conv-act" data-act="open">📄</button>` : ""}${vaultCanWrite ? `<button class="conv-act" data-act="edit">✎</button>` : ""}</div>
    </div>`).join("");
  listEl.querySelectorAll(".vault-item").forEach((it) => {
    const entry = vaultEntries.find((e) => e.id === it.dataset.id);
    it.querySelector('[data-act="open"]')?.addEventListener("click", () => openVaultFilePreview(entry.id, entry));
    it.querySelector('[data-act="edit"]')?.addEventListener("click", () => vaultEdit(entry));
  });
}

// Open an entry's attachment in the artifact-style preview.
async function openVaultFilePreview(id, entry) {
  const res = await tools.open_vault_file({ id });
  if (res.error) { toast(res.error, "error", 3000); return; }
  if (res.text != null) openArtifact(`<pre style="white-space:pre-wrap;font-family:system-ui;padding:14px">${escapeHtml(res.text)}</pre>`);
  else if (res.image) openArtifact(`<img src="data:${res.image.media_type};base64,${res.image.data}" style="max-width:100%"/>`);
  else if (res.document) {
    openModal(`<div class="artifact-head"><h3 style="margin:0">${escapeHtml(entry?.title || "Dokument")}</h3><button class="btn" data-act="close">Stäng</button></div>
      <iframe class="artifact-frame" title="PDF"></iframe>`);
    els.modalCard.classList.add("wide");
    els.modalCard.querySelector(".artifact-frame").src = `data:application/pdf;base64,${res.document.data}`;
    els.modalCard.querySelector('[data-act="close"]').onclick = closeModalSilently;
  }
}

async function analyzeVaultUI() {
  openModal(`<h3>Analys av kunskapsbanken</h3><div class="hint" style="padding:8px 2px"><span class="spinner"></span> Simba granskar banken…</div>`);
  try {
    const token = await getSsoToken(false);
    const r = await fetch(`${API_BASE}/api/vault/analyze`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: "{}" });
    const j = await r.json().catch(() => ({}));
    const body = r.ok ? formatMarkdown(j.text || "") : `<p>${escapeHtml(j.error || "Kunde inte analysera.")}</p>`;
    openModal(`<div class="artifact-head"><h3 style="margin:0">Analys av kunskapsbanken</h3><button class="btn" data-act="back">Tillbaka</button></div><div class="bubble" style="max-height:60vh;overflow:auto">${body}</div><div class="modal-actions"><button class="btn primary" data-act="close">Klar</button></div>`);
    els.modalCard.querySelector('[data-act="back"]').onclick = () => openVault();
    els.modalCard.querySelector('[data-act="close"]').onclick = closeModalSilently;
  } catch { toast("Kunde inte nå kunskapsbanken.", "error", 3000); }
}

// Add or edit a vault entry (optionally with a file/PDF/document), then return.
function vaultEdit(entry) {
  const e = entry || { topic: "Allmänt", title: "", content: "", tags: [] };
  let pickedFile = null; // {name,type,data,text}
  openModal(
    `<h3>${entry ? "Redigera post" : "Ny post"}</h3>
     <label class="vault-l">Ämne / gren</label>
     <input id="v-topic" class="files-q" type="text" value="${escapeHtml(e.topic || "")}" placeholder="t.ex. Produkter, Policys, Kunder" />
     <label class="vault-l">Titel</label>
     <input id="v-title" class="files-q" type="text" value="${escapeHtml(e.title || "")}" placeholder="Kort, specifik titel" />
     <label class="vault-l">Innehåll</label>
     <textarea id="v-content" class="memory-text" rows="6" placeholder="Faktan, skriven så den är användbar senare.">${escapeHtml(e.content || "")}</textarea>
     <label class="vault-l">Taggar (kommaseparerade)</label>
     <input id="v-tags" class="files-q" type="text" value="${escapeHtml((e.tags || []).join(", "))}" placeholder="valfritt" />
     <label class="vault-l">Bilaga (dokument, PDF, bild, CSV) — valfritt</label>
     <div style="display:flex;align-items:center;gap:8px"><button class="btn" id="v-filebtn" type="button">Välj fil…</button><span id="v-filename" class="hint">${e.file ? escapeHtml(e.file.name) + " (befintlig)" : "Ingen vald"}</span></div>
     <input type="file" id="v-file" accept=".csv,.tsv,.txt,.md,.json,.tab,image/png,image/jpeg,image/gif,image/webp,application/pdf" hidden />
     <div class="modal-actions"><button class="btn" data-act="cancel">Avbryt</button><button class="btn primary" data-act="save">Spara</button></div>`
  );
  const fileInput = els.modalCard.querySelector("#v-file");
  els.modalCard.querySelector("#v-filebtn").onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (f.size > 9 * 1024 * 1024) { toast("Filen är för stor (max 9 MB).", "error", 3000); return; }
    const type = f.type || "";
    const isText = /^text\//.test(type) || /\.(csv|tsv|txt|md|json|tab)$/i.test(f.name);
    try {
      if (isText) { const text = await readFile(f, false); pickedFile = { name: f.name, type: type || "text/plain", data: btoa(unescape(encodeURIComponent(text))), text: text.slice(0, 16000) }; }
      else { const data = (await readFile(f, true)).split(",")[1]; pickedFile = { name: f.name, type, data, text: "" }; }
      els.modalCard.querySelector("#v-filename").textContent = f.name;
    } catch { toast("Kunde inte läsa filen.", "error", 3000); }
  };
  els.modalCard.querySelector('[data-act="cancel"]').onclick = () => openVault();
  els.modalCard.querySelector('[data-act="save"]').onclick = async () => {
    const body = {
      topic: els.modalCard.querySelector("#v-topic").value.trim(),
      title: els.modalCard.querySelector("#v-title").value.trim(),
      content: els.modalCard.querySelector("#v-content").value.trim(),
      tags: els.modalCard.querySelector("#v-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    if (pickedFile) body.file = pickedFile;
    if (!body.title || !body.content) { toast("Ange titel och innehåll.", "error", 2500); return; }
    const token = await getSsoToken(false);
    const url = entry ? `${API_BASE}/api/vault/${encodeURIComponent(entry.id)}` : `${API_BASE}/api/vault`;
    const r = await fetch(url, { method: entry ? "PUT" : "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).catch(() => null);
    if (r && r.ok) { toast("Sparat i kunskapsbanken", "success", 1500); openVault(); }
    else { const j = r ? await r.json().catch(() => ({})) : {}; toast(j.error || "Kunde inte spara.", "error", 3000); }
  };
}

/* ---- Finance / business-system connectors (admin) --------------------- */
async function openConnectors() {
  const token = await getSsoToken(false);
  if (!token) {
    openModal(`<h3>Datakällor</h3><p class="sub">Logga in med Microsoft för att se företagets datakällor (ekonomisystem m.m.).</p>
      <div class="modal-actions"><button class="btn" data-act="cancel">Avbryt</button><button class="btn primary" id="dc-signin">Logga in</button></div>`);
    els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
    els.modalCard.querySelector("#dc-signin").onclick = async () => { if (await initIdentity(true)) openConnectors(); else toast("Kunde inte logga in.", "error", 3000); };
    return;
  }
  openModal(
    `<div class="vault-head">
       <div><h3 style="margin:0">Datakällor</h3><p class="sub" style="margin:2px 0 0">Brygga till ekonomisystem (Fortnox, Visma, projektverktyg…). Simba kan hämta och sammanfatta fakturering, intäkter och projekt.</p></div>
       <button class="btn primary" id="dc-new" style="padding:7px 12px" hidden>＋ Ny</button>
     </div>
     <div id="dc-list" class="vault-list"><div class="hint" style="padding:6px 2px">Laddar…</div></div>
     <div class="modal-actions"><button class="btn" data-act="cancel">Stäng</button></div>`
  );
  els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
  els.modalCard.querySelector("#dc-new").onclick = () => connectorEdit(null);
  loadConnectors();
}

async function loadConnectors() {
  const el = els.modalCard.querySelector("#dc-list");
  if (!el) return;
  try {
    const token = await getSsoToken(false);
    const r = await fetch(`${API_BASE}/api/connectors`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { el.innerHTML = `<div class="hint" style="padding:6px 2px">${escapeHtml(j.error || "Kunde inte hämta.")}</div>`; return; }
    const canManage = !!j.canManage;
    const nb = els.modalCard.querySelector("#dc-new"); if (nb) nb.hidden = !canManage;
    const cs = j.connectors || [];
    if (!cs.length) {
      el.innerHTML = `<div class="hint" style="padding:6px 2px">${canManage ? "Inga datakällor än. Lägg till t.ex. Fortnox eller Visma med bas-URL, API-nyckel och de läs-endpoints Simba får använda." : "Inga datakällor är konfigurerade. Be en administratör lägga till ert ekonomisystem."}</div>`;
      return;
    }
    el.innerHTML = cs.map((c) => `
      <div class="vault-item" data-id="${escapeHtml(c.id)}">
        <div class="vault-main"><div class="vault-title">🔌 ${escapeHtml(c.name)}</div>
        <div class="vault-snip">${escapeHtml(c.base_url)} · ${(c.endpoints || []).length} endpoints${c.headerNames?.length ? ` · 🔑 ${c.headerNames.length}` : ""}</div></div>
        ${canManage ? `<div class="vault-acts"><button class="conv-act" data-act="edit" title="Redigera">✎</button><button class="conv-act" data-act="del" title="Ta bort">🗑</button></div>` : ""}
      </div>`).join("");
    el.querySelectorAll(".vault-item").forEach((it) => {
      const c = cs.find((x) => x.id === it.dataset.id);
      it.querySelector('[data-act="edit"]')?.addEventListener("click", () => connectorEdit(c));
      it.querySelector('[data-act="del"]')?.addEventListener("click", async () => {
        if (!(await uiConfirm(`Ta bort datakällan "${c.name}"?`, { danger: true }))) { openConnectors(); return; }
        const t = await getSsoToken(false);
        await fetch(`${API_BASE}/api/connectors/${encodeURIComponent(c.id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${t}` } }).catch(() => {});
        openConnectors();
      });
    });
  } catch { el.innerHTML = '<div class="hint" style="padding:6px 2px">Kunde inte nå datakälletjänsten.</div>'; }
}

function connectorEdit(c) {
  const e = c || { name: "", base_url: "https://", endpoints: [], headerNames: [] };
  const endpointLines = (e.endpoints || []).map((x) => `${x.label || x.key} | ${x.path}${x.description ? ` | ${x.description}` : ""}`).join("\n");
  openModal(
    `<h3>${c ? "Redigera datakälla" : "Ny datakälla"}</h3>
     <label class="vault-l">Namn</label>
     <input id="dc-name" class="files-q" type="text" value="${escapeHtml(e.name || "")}" placeholder="t.ex. Fortnox" />
     <label class="vault-l">Bas-URL (HTTPS)</label>
     <input id="dc-base" class="files-q" type="text" value="${escapeHtml(e.base_url || "https://")}" placeholder="https://api.fortnox.se/3" />
     <label class="vault-l">Autentiseringsheaders ${c ? "(lämna tomt för att behålla)" : ""}</label>
     <textarea id="dc-headers" class="memory-text" rows="3" placeholder="En per rad, Header: värde&#10;Access-Token: ...&#10;Client-Secret: ...">${c && e.headerNames?.length ? `# befintliga: ${e.headerNames.join(", ")}` : ""}</textarea>
     <label class="vault-l">Endpoints (en per rad: etikett | sökväg | beskrivning)</label>
     <textarea id="dc-endpoints" class="memory-text" rows="5" placeholder="Obetalda fakturor | invoices?filter=unpaid | Fakturor som inte betalats&#10;Projekt | projects | Pågående projekt">${escapeHtml(endpointLines)}</textarea>
     <div class="modal-actions"><button class="btn" data-act="cancel">Avbryt</button><button class="btn primary" data-act="save">Spara</button></div>`
  );
  els.modalCard.querySelector('[data-act="cancel"]').onclick = () => openConnectors();
  els.modalCard.querySelector('[data-act="save"]').onclick = async () => {
    const name = els.modalCard.querySelector("#dc-name").value.trim();
    const base_url = els.modalCard.querySelector("#dc-base").value.trim();
    const headersRaw = els.modalCard.querySelector("#dc-headers").value;
    const endpointsRaw = els.modalCard.querySelector("#dc-endpoints").value;
    if (!name || !/^https:\/\//i.test(base_url)) { toast("Ange namn och en HTTPS bas-URL.", "error", 2800); return; }
    const endpoints = endpointsRaw.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [label, path, description] = l.split("|").map((s) => s.trim());
      return { label, path, description: description || "" };
    }).filter((x) => x.path);
    const body = { name, base_url, endpoints };
    // Only send headers if the admin typed real ones (not the "# befintliga" hint).
    const headerLines = headersRaw.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    if (headerLines.length) {
      body.headers = {};
      for (const line of headerLines) { const i = line.indexOf(":"); if (i > 0) body.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    }
    const token = await getSsoToken(false);
    const url = c ? `${API_BASE}/api/connectors/${encodeURIComponent(c.id)}` : `${API_BASE}/api/connectors`;
    const r = await fetch(url, { method: c ? "PUT" : "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).catch(() => null);
    if (r && r.ok) { toast("Datakälla sparad", "success", 1500); openConnectors(); }
    else { const j = r ? await r.json().catch(() => ({})) : {}; toast(j.error || "Kunde inte spara.", "error", 3000); }
  };
}

/* ---- Outlook mail panel ------------------------------------------------ */
function mailDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
  } catch { return ""; }
}

async function openMail() {
  const token = await getSsoToken(false);
  if (!token) {
    openModal(
      `<h3>E-post</h3><p class="sub">Logga in med Microsoft för att läsa din Outlook-inkorg.</p>
       <div class="modal-actions"><button class="btn" data-act="cancel">Avbryt</button><button class="btn primary" id="mail-signin">Logga in</button></div>`
    );
    els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
    els.modalCard.querySelector("#mail-signin").onclick = async () => { if (await initIdentity(true)) openMail(); else toast("Kunde inte logga in.", "error", 3000); };
    return;
  }
  openModal(
    `<div class="vault-head">
       <div><h3 style="margin:0">E-post</h3><p class="sub" style="margin:2px 0 0">Din Outlook-inkorg — läs, sök, analysera och svara.</p></div>
       <button class="btn primary" id="mail-new" style="padding:7px 12px">＋ Nytt</button>
     </div>
     <div class="mail-controls">
       <select id="mail-folder" class="mail-folder">
         <option value="inbox">📥 Inkorg</option>
         <option value="sentitems">📤 Skickat</option>
         <option value="drafts">📝 Utkast</option>
         <option value="archive">🗄 Arkiv</option>
       </select>
       <input id="mail-q" class="files-q" type="search" placeholder="Sök i mejlen…" autocomplete="off" style="margin:0;flex:1" />
     </div>
     <div id="mail-list" class="mail-list"><div class="hint" style="padding:6px 2px">Hämtar inkorgen…</div></div>
     <div class="modal-actions"><button class="btn" data-act="cancel">Stäng</button></div>`
  );
  els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
  els.modalCard.querySelector("#mail-new").onclick = () => mailCompose(null);
  const qEl = els.modalCard.querySelector("#mail-q");
  const folderEl = els.modalCard.querySelector("#mail-folder");
  folderEl.value = mailFolder;
  folderEl.onchange = () => { mailFolder = folderEl.value; qEl.value = ""; loadMail(""); };
  let deb;
  qEl.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => loadMail(qEl.value.trim()), 350); });
  loadMail("");
}

async function loadMail(query) {
  const listEl = els.modalCard.querySelector("#mail-list");
  if (!listEl) return;
  listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Söker…</div>';
  // Search is mailbox-wide in Graph; folder applies only when not searching.
  const res = await tools.list_emails(query ? { query, limit: 25 } : { folder: mailFolder, limit: 25 });
  if (res.error) { listEl.innerHTML = `<div class="hint" style="padding:6px 2px">${escapeHtml(res.error)}</div>`; return; }
  const msgs = res.messages || [];
  if (!msgs.length) { listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Inga mejl hittades.</div>'; return; }
  listEl.innerHTML = msgs.map((m, i) => `
    <button class="mail-item${m.isRead ? "" : " unread"}" data-i="${i}">
      <span class="mail-dot" aria-hidden="true"></span>
      <span class="mail-main">
        <span class="mail-row1"><span class="mail-from">${escapeHtml(m.fromName || m.from || "")}</span><span class="mail-date">${escapeHtml(mailDate(m.received))}</span></span>
        <span class="mail-subj">${m.hasAttachments ? "📎 " : ""}${escapeHtml(m.subject || "")}</span>
        <span class="mail-prev">${escapeHtml(String(m.preview || "").slice(0, 110))}</span>
      </span>
    </button>`).join("");
  listEl.querySelectorAll(".mail-item").forEach((b) => b.addEventListener("click", () => openMailRead(msgs[+b.dataset.i])));
}

async function openMailRead(meta) {
  openModal(`<div class="hint" style="padding:10px 2px"><span class="spinner"></span> Öppnar mejlet…</div>`);
  const res = await tools.read_email({ id: meta.id });
  if (res.error) { toast(res.error, "error", 3000); openMail(); return; }
  const m = res.message || {};
  openModal(
    `<div class="artifact-head"><h3 style="margin:0;font-size:16px">${escapeHtml(m.subject || "(inget ämne)")}</h3><button class="btn" data-act="back">Tillbaka</button></div>
     <div class="hint" style="padding:2px 0"><b>Från:</b> ${escapeHtml(m.fromName || m.from || "")}${m.from ? ` &lt;${escapeHtml(m.from)}&gt;` : ""} · ${escapeHtml(mailDate(m.received))}</div>
     ${m.to?.length ? `<div class="hint" style="padding:2px 0"><b>Till:</b> ${escapeHtml(m.to.join(", "))}</div>` : ""}
     <div id="mail-att" class="mail-att"></div>
     <div class="bubble" style="max-height:44vh;overflow:auto;white-space:pre-wrap;margin-top:8px">${escapeHtml(m.body || "")}</div>
     <div class="modal-actions">
       <button class="btn" id="mail-analyze">Analysera med Simba</button>
       <button class="btn primary" id="mail-reply">Svara</button>
     </div>`
  );
  els.modalCard.querySelector('[data-act="back"]').onclick = () => openMail();
  if (meta.hasAttachments) loadMailAttachments(m.id);
  els.modalCard.querySelector("#mail-reply").onclick = () => mailCompose({ replyToId: m.id, to: m.from, subject: `SV: ${m.subject || ""}` });
  els.modalCard.querySelector("#mail-analyze").onclick = () => {
    // Stage the email as context and let the user ask Simba about it.
    if (pendingAttachments.length < MAX_ATTACH) {
      pendingAttachments.push({ name: m.subject || "mejl", kind: "mejl", block: { type: "text", text: `E-post från ${m.fromName || m.from} (${m.received}):\nÄmne: ${m.subject}\n\n${m.body || ""}` } });
      renderAttachChip();
    }
    closeModalSilently();
    els.prompt.value = "Sammanfatta det här mejlet och föreslå ett svar.";
    els.prompt.focus(); autoGrow();
  };
}

async function loadMailAttachments(messageId) {
  const el = els.modalCard.querySelector("#mail-att");
  if (!el) return;
  try {
    const token = await getSsoToken(false);
    const r = await fetch(`${API_BASE}/api/mail/${encodeURIComponent(messageId)}/attachments`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    const atts = (j.attachments || []);
    if (!r.ok || !atts.length) return;
    el.innerHTML = `<div class="hint" style="padding:2px 0">Bilagor</div>` + atts.map((a, i) =>
      `<span class="att-pill" data-i="${i}"><span>${fileIcon(a.name)}</span><span class="att-name">${escapeHtml(a.name)}</span><span class="att-size">${fileSizeText(a.size)}</span><button class="att-dl" title="Ladda ner / öppna">⬇</button></span>`).join("");
    el.querySelectorAll(".att-pill").forEach((p) => p.querySelector(".att-dl").addEventListener("click", () => downloadMailAttachment(messageId, atts[+p.dataset.i])));
  } catch { /* ignore */ }
}

async function downloadMailAttachment(messageId, att) {
  toast(`Hämtar ${att.name}…`, "info", 1200);
  try {
    const token = await getSsoToken(false);
    const r = await fetch(`${API_BASE}/api/mail/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.id)}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.data) { toast(j.error || "Kunde inte hämta bilagan.", "error", 3000); return; }
    saveBase64(j.data, j.name || att.name, j.type || att.type);
  } catch { toast("Kunde inte nå e-posttjänsten.", "error", 3000); }
}

function mailCompose(opts) {
  const o = opts || {};
  openModal(
    `<h3>${o.replyToId ? "Svara" : "Nytt mejl"}</h3>
     ${o.replyToId ? "" : `<label class="vault-l">Till</label><input id="m-to" class="files-q" type="text" value="${escapeHtml(o.to || "")}" placeholder="mottagare@exempel.se, ..." />
     <label class="vault-l">Kopia (valfritt)</label><input id="m-cc" class="files-q" type="text" placeholder="cc@exempel.se" />
     <label class="vault-l">Ämne</label><input id="m-subject" class="files-q" type="text" value="${escapeHtml(o.subject || "")}" />`}
     ${o.replyToId ? `<div class="hint" style="padding:2px 0">Svar till <b>${escapeHtml(o.to || "")}</b> · ${escapeHtml(o.subject || "")}</div>` : ""}
     <label class="vault-l">Meddelande</label>
     <textarea id="m-body" class="memory-text" rows="8" placeholder="Skriv ditt meddelande…"></textarea>
     <div class="modal-actions"><button class="btn" data-act="cancel">Avbryt</button><button class="btn primary" data-act="send">Granska & skicka</button></div>`
  );
  els.modalCard.querySelector('[data-act="cancel"]').onclick = () => openMail();
  els.modalCard.querySelector('[data-act="send"]').onclick = async () => {
    const body = els.modalCard.querySelector("#m-body").value.trim();
    const to = o.replyToId ? o.to : (els.modalCard.querySelector("#m-to")?.value.trim() || "");
    const cc = els.modalCard.querySelector("#m-cc")?.value.trim() || "";
    const subject = o.replyToId ? o.subject : (els.modalCard.querySelector("#m-subject")?.value.trim() || "");
    if (!body) { toast("Mejlet saknar innehåll.", "error", 2500); return; }
    if (!o.replyToId && !to) { toast("Ange minst en mottagare.", "error", 2500); return; }
    if (!(await confirmSend({ to: o.replyToId ? `${o.to} (svar i tråden)` : to, cc, subject, body }))) return;
    const token = await getSsoToken(false);
    const r = await fetch(`${API_BASE}/api/mail/send`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, cc, subject, body, replyToId: o.replyToId }),
    }).catch(() => null);
    if (r && r.ok) { toast("Mejlet skickades", "success"); openMail(); }
    else { const j = r ? await r.json().catch(() => ({})) : {}; toast(j.error || "Kunde inte skicka.", "error", 3000); }
  };
}

/* ---- Cloud file browser (OneDrive/SharePoint) -------------------------- */
function fileSizeText(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} kB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

async function openFilesBrowser() {
  const token = await getSsoToken(false);
  if (!token) {
    openModal(
      `<h3>Molnfiler</h3>
       <p class="sub">Logga in med Microsoft för att bläddra bland dina OneDrive- och SharePoint-filer.</p>
       <div class="modal-actions">
         <button class="btn" data-act="cancel">Avbryt</button>
         <button class="btn primary" id="files-signin">Logga in</button>
       </div>`
    );
    els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
    els.modalCard.querySelector("#files-signin").onclick = async () => {
      const ok = await initIdentity(true);
      if (ok) openFilesBrowser(); else toast("Kunde inte logga in.", "error", 3000);
    };
    return;
  }
  openModal(
    `<h3>Molnfiler</h3>
     <p class="sub">Sök i OneDrive/SharePoint och välj en fil. Den läses in så Simba kan använda den.</p>
     <input id="files-q" class="files-q" type="search" placeholder="Sök filer…" autocomplete="off" />
     <div id="files-list" class="files-list"><div class="hint" style="padding:6px 2px">Hämtar senaste filer…</div></div>
     <div class="modal-actions"><button class="btn primary" data-act="cancel">Stäng</button></div>`
  );
  els.modalCard.querySelector('[data-act="cancel"]').onclick = closeModalSilently;
  const listEl = els.modalCard.querySelector("#files-list");
  const qEl = els.modalCard.querySelector("#files-q");

  const load = async (q) => {
    listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Söker…</div>';
    try {
      const t = await getSsoToken(false);
      const r = await fetch(`${API_BASE}/api/files?q=${encodeURIComponent(q || "")}`, { headers: { Authorization: `Bearer ${t}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { listEl.innerHTML = `<div class="hint" style="padding:6px 2px">${escapeHtml(j.error || "Kunde inte hämta filer.")}</div>`; return; }
      const files = j.files || [];
      if (!files.length) { listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Inga filer hittades.</div>'; return; }
      listEl.innerHTML = files.map((f, i) => `
        <button class="file-item" data-i="${i}">
          <span class="file-ic">${fileIcon(f.name)}</span>
          <span class="file-main"><span class="file-name">${escapeHtml(f.name)}</span>
          <span class="file-meta">${escapeHtml([fileSizeText(f.size), f.modified ? nextRunText(Date.parse(f.modified)) : ""].filter(Boolean).join(" · "))}</span></span>
        </button>`).join("");
      listEl.querySelectorAll(".file-item").forEach((b) =>
        b.addEventListener("click", () => pickCloudFile(files[+b.dataset.i])));
    } catch { listEl.innerHTML = '<div class="hint" style="padding:6px 2px">Kunde inte nå filtjänsten.</div>'; }
  };

  let deb;
  qEl.addEventListener("input", () => { clearTimeout(deb); deb = setTimeout(() => load(qEl.value.trim()), 300); });
  qEl.focus();
  load(""); // recent files
}

function fileIcon(name) {
  const n = String(name || "").toLowerCase();
  if (/\.(xlsx|xls|csv|tsv)$/.test(n)) return "📊";
  if (/\.(docx?|txt|md|rtf)$/.test(n)) return "📄";
  if (/\.(pptx?|key)$/.test(n)) return "📈";
  if (/\.pdf$/.test(n)) return "📕";
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(n)) return "🖼";
  return "📁";
}

// Open a cloud file and stage it as an attachment for the next message.
async function pickCloudFile(file) {
  if (!file) return;
  toast(`Öppnar ${file.name}…`, "info", 1500);
  try {
    const token = await getSsoToken(false);
    const r = await fetch(`${API_BASE}/api/files/open`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: file.id }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error || "Kunde inte öppna filen.", "error", 3500); return; }
    if (pendingAttachments.length >= MAX_ATTACH) { toast(`Max ${MAX_ATTACH} filer åt gången.`, "info", 2500); return; }
    let att = null;
    if (j.kind === "text") {
      att = { name: j.name, kind: "molnfil", block: { type: "text", text: `Fil "${j.name}" (från OneDrive/SharePoint):\n\n${j.text}` } };
    } else if (j.kind === "image") {
      att = { name: j.name, kind: "bild", block: { type: "image", source: { type: "base64", media_type: j.media_type, data: j.data } } };
    } else if (j.kind === "pdf") {
      att = { name: j.name, kind: "PDF", block: { type: "document", source: { type: "base64", media_type: "application/pdf", data: j.data } } };
    } else { toast("Filtypen stöds inte ännu (text/CSV, bild eller PDF).", "error", 3500); return; }
    pendingAttachments.push(att);
    renderAttachChip();
    closeModalSilently();
    toast(`La till ${j.name}`, "success");
    els.prompt?.focus();
  } catch { toast("Kunde inte nå filtjänsten.", "error", 3500); }
}

// The standalone app's persistent sidebar list.
let sidebarConvs = []; // cached for client-side search
async function refreshSidebar() {
  const el = document.getElementById("sb-list");
  if (!el) return;
  if (!signedIn) { el.innerHTML = '<div class="hint" style="padding:6px 4px">Logga in för att spara och synka chattar.</div>'; return; }
  sidebarConvs = (await fetchConvList()) || [];
  const search = document.getElementById("sb-search");
  if (search && !search._wired) {
    search._wired = true;
    search.addEventListener("input", renderSidebarList);
  }
  renderSidebarList();
}
function renderSidebarList() {
  const el = document.getElementById("sb-list");
  if (!el) return;
  const q = (document.getElementById("sb-search")?.value || "").trim().toLowerCase();
  const list = q ? sidebarConvs.filter((c) => (c.title || "").toLowerCase().includes(q)) : sidebarConvs;
  renderConvInto(el, list, 40, null);
}

// Rebuild the visible chat from a stored message list (skips tool plumbing).
function renderHistory(msgs) {
  els.messages.innerHTML = "";
  document.body.classList.toggle("has-chat", Array.isArray(msgs) && msgs.length > 0);
  for (const m of msgs) {
    if (m.role === "user") {
      const c = m.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
      if (isToolResult) continue;
      let text = typeof c === "string" ? c
        : Array.isArray(c) ? (c.find((b) => b && b.type === "text")?.text || "") : "";
      text = text.replace(/\n\n\[Aktuell markering:[\s\S]*$/, "");
      const hasFile = Array.isArray(c) && c.some((b) => b && (b.type === "image" || b.type === "document"));
      if (text.trim() || hasFile) renderMessage("user", text, hasFile ? { file: "bifogad fil" } : null);
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
      if (text) renderMessage("assistant", text);
    }
  }
  if (!els.messages.children.length) clearWelcome();
  scrollDown();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
