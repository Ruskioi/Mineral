/*
 * Simba AI — Excel task pane.
 *
 * Drives a chat UI in the sidebar and runs an agentic loop against the Simba
 * backend (/api/chat), which proxies the Claude API. Claude can request Excel
 * tools (read/write ranges, formulas, selection); those run here via Office.js
 * and the results are fed back until Claude produces a final answer.
 */

import "./taskpane.css";

// Backend base URL. Baked in at build time from SIMBA_API_BASE (see
// webpack.config.js). Empty string = same origin (dev uses the dev-server
// proxy; production can point at a separately hosted backend, e.g.
// SIMBA_API_BASE=https://simba-api.example.com npm run build).
const API_BASE = (typeof __SIMBA_API_BASE__ !== "undefined" && __SIMBA_API_BASE__) || "";

/** Full conversation in Anthropic message format. */
let messages = [];
let busy = false;
let autoApply = true;

const els = {};

Office.onReady((info) => {
  if (info.host !== Office.HostType.Excel) {
    document.body.innerHTML =
      "<p style='padding:16px'>Simba AI runs inside Microsoft Excel.</p>";
    return;
  }

  els.messages = document.getElementById("messages");
  els.prompt = document.getElementById("prompt");
  els.send = document.getElementById("send");
  els.newChat = document.getElementById("new-chat");
  els.contextPill = document.getElementById("context-pill");
  els.errorBar = document.getElementById("error-bar");
  els.autoApply = document.getElementById("auto-apply");

  els.send.addEventListener("click", onSend);
  els.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  });
  els.prompt.addEventListener("input", autoGrow);
  els.newChat.addEventListener("click", resetChat);
  els.autoApply.addEventListener("change", () => (autoApply = els.autoApply.checked));

  document.querySelectorAll(".suggestion").forEach((b) =>
    b.addEventListener("click", () => {
      els.prompt.value = b.textContent;
      onSend();
    })
  );

  // Keep the context pill in sync with the user's selection.
  refreshContextPill();
  Excel.run(async (ctx) => {
    ctx.workbook.worksheets.onSelectionChanged?.add?.(refreshContextPill);
    await ctx.sync();
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
      return {
        address: range.address,
        rowCount: range.rowCount,
        columnCount: range.columnCount,
        values: range.values,
      };
    });
  },

  async read_range({ address }) {
    return Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.load(["address", "values", "rowCount", "columnCount"]);
      await ctx.sync();
      return {
        address: range.address,
        rowCount: range.rowCount,
        columnCount: range.columnCount,
        values: range.values,
      };
    });
  },

  async write_range({ address, values }) {
    if (!autoApply) {
      return { skipped: true, reason: "Sheet editing is turned off by the user." };
    }
    return Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      range.values = values;
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address };
    });
  },

  async set_formula({ address, formula }) {
    if (!autoApply) {
      return { skipped: true, reason: "Sheet editing is turned off by the user." };
    }
    return Excel.run(async (ctx) => {
      const range = parseRange(ctx, address);
      // Broadcast a single formula to every cell in the range.
      range.load(["rowCount", "columnCount"]);
      await ctx.sync();
      const grid = Array.from({ length: range.rowCount }, () =>
        Array.from({ length: range.columnCount }, () => formula)
      );
      range.formulas = grid;
      range.load("address");
      await ctx.sync();
      return { written: true, address: range.address, formula };
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
};

/** Accept either "A1:C5" (active sheet) or "Sheet1!A1:C5". */
function parseRange(ctx, address) {
  if (address.includes("!")) {
    const [sheetName, ref] = address.split("!");
    return ctx.workbook.worksheets
      .getItem(sheetName.replace(/^'|'$/g, ""))
      .getRange(ref);
  }
  return ctx.workbook.worksheets.getActiveWorksheet().getRange(address);
}

/* ------------------------------------------------------------------ *
 * Chat loop
 * ------------------------------------------------------------------ */

async function onSend() {
  const text = els.prompt.value.trim();
  if (!text || busy) return;

  hideError();
  clearWelcome();
  els.prompt.value = "";
  autoGrow();

  // Give Claude fresh context about the current selection on every turn.
  let selectionNote = "";
  try {
    const sel = await tools.get_selection();
    selectionNote = `\n\n[Current selection: ${sel.address} (${sel.rowCount}×${sel.columnCount})]`;
  } catch {
    /* no active selection */
  }

  messages.push({ role: "user", content: text + selectionNote });
  renderMessage("user", text);

  setBusy(true);
  const typing = renderTyping();

  try {
    await runAgentLoop();
  } catch (err) {
    showError(err.message || "Something went wrong talking to Simba.");
  } finally {
    typing.remove();
    setBusy(false);
  }
}

async function runAgentLoop() {
  // Bounded loop: model ↔ tools until it stops asking for tools.
  for (let i = 0; i < 12; i++) {
    const reply = await callBackend(messages);
    messages.push({ role: "assistant", content: reply.content });

    const textBlocks = reply.content.filter((b) => b.type === "text");
    for (const b of textBlocks) {
      if (b.text.trim()) renderMessage("assistant", b.text);
    }

    if (reply.stop_reason !== "tool_use") return;

    const toolUses = reply.content.filter((b) => b.type === "tool_use");
    const results = [];
    for (const use of toolUses) {
      renderToolNote(use.name, use.input);
      let result, isError = false;
      try {
        const fn = tools[use.name];
        result = fn ? await fn(use.input || {}) : { error: `Unknown tool ${use.name}` };
      } catch (e) {
        result = { error: e.message || String(e) };
        isError = true;
      }
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
 * Rendering
 * ------------------------------------------------------------------ */

function renderMessage(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const label = document.createElement("div");
  label.className = "role";
  label.textContent = role === "user" ? "You" : "Simba";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = formatMarkdown(text);
  wrap.append(label, bubble);
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
  note.innerHTML = `<div class="tool-note"><span class="dot">●</span>${
    labels[name] || name
  }</div>`;
  els.messages.append(note);
  scrollDown();
}

function renderTyping() {
  const el = document.createElement("div");
  el.className = "msg assistant";
  el.innerHTML = '<div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>';
  els.messages.append(el);
  scrollDown();
  return el;
}

/** Minimal, safe markdown: escapes HTML, then adds code/bold/italic. */
function formatMarkdown(text) {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${c.trim()}</code></pre>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br>");
}

/* ------------------------------------------------------------------ *
 * UI helpers
 * ------------------------------------------------------------------ */

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
  els.messages.scrollTop = els.messages.scrollHeight;
}

function clearWelcome() {
  els.messages.querySelector(".welcome")?.remove();
}

function resetChat() {
  messages = [];
  els.messages.innerHTML =
    '<div class="welcome"><h2>New chat</h2><p>What would you like to do with your spreadsheet?</p></div>';
  hideError();
}

function showError(msg) {
  els.errorBar.textContent = msg;
  els.errorBar.hidden = false;
}
function hideError() {
  els.errorBar.hidden = true;
}

async function refreshContextPill() {
  try {
    const sel = await tools.get_selection();
    els.contextPill.textContent = `Selected ${sel.address}`;
  } catch {
    els.contextPill.textContent = "No selection";
  }
}
