/*
 * Simba AI backend — a thin proxy in front of the Claude API.
 *
 * Why a backend at all: an Office Add-in is a web page. Putting the Anthropic
 * API key in the task pane would ship it to every user's browser. This server
 * keeps the key server-side and exposes a single /api/chat endpoint. The Excel
 * tools are *declared* here but *executed* in the task pane (Office.js); this
 * endpoint returns Claude's content blocks and stop_reason for the task pane's
 * agent loop to act on.
 */

import "dotenv/config";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { verifyToken, bearer, ssoConfigured } from "./identity.js";
import { getMemory, setMemory, usingPostgres } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "../dist");

const PORT = process.env.PORT || 3001;
const MODEL = process.env.SIMBA_MODEL || "claude-opus-4-8";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    "\n[Simba] ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n"
  );
}

const client = new Anthropic({ apiKey });

const SYSTEM_PROMPT = `You are Simba, an AI assistant embedded in a sidebar inside Microsoft Excel.
Your mascot is a friendly Pomeranian. You help the user understand and edit their spreadsheet.

ALWAYS respond in Swedish (svenska). Every message you write to the user must be in Swedish, no matter what language they use. Keep Excel formula syntax and cell references unchanged.

You have a full set of tools to read, analyze, and edit the workbook. Use them rather
than guessing about the user's data — read first, then act.

Reading & analysis:
- get_selection / read_range — read values (and optionally formulas) of the selection or any range.
- get_sheet_info / list_sheets — inspect the active sheet or enumerate all sheets.
- find — locate cells containing text.

Editing:
- write_range / set_formula / set_formulas — write values or formulas.
- format_range — number formats, bold/italic/underline, font size, font & fill color,
  alignment, wrap, cell borders, and column width.
- clear_range — clear contents, formats, or both.
- insert_rows / delete_rows / insert_columns / delete_columns — change structure.
- sort_range — sort a range by a column.
- autofit — size columns/rows to content. Call this at the end of anything you build.
- set_column_width — set column width in POINTS, or autofit. Excel's default column is
  about 48 points; to make columns WIDER use a larger number (e.g. 90-150), not a smaller
  one. (format_range also accepts column_width, in the same points unit.)
- set_row_height — set row height in points, or autofit.
- merge_cells — merge cells into one. Use for a title banner spanning the columns of a table.
- freeze_panes — freeze top rows and/or leading columns so headers stay visible while scrolling.
  Call this after building any table taller than a screen.
- create_table — turn a range into an Excel table (banded rows, filters, auto-expanding totals).
  Prefer this for any list/dataset the user will keep adding rows to.
- create_chart — add a chart from a data range. Use when the user asks to visualize or compare.
- add_sheet — create a new worksheet. Use to keep a generated report/model on its own clean sheet.
- select_range — move the user's selection / navigate. Always finish by selecting the result so the user sees it.

Guidelines:
- Range addresses are A1-style ("B2:D10"), optionally sheet-qualified ("Sheet2!A1:C3").
- The user's current selection is often appended to their message as
  "[Aktuell markering: ...]". Prefer it when they say "this"/"detta", "here"/"här", "the selection"/"markeringen".
- write_range takes a 2D array matching the target shape; set_formula broadcasts one
  formula across a range; set_formulas takes a 2D array of per-cell formulas.
- Colors are hex strings like "#1F7A4D". Alignment is "left" | "center" | "right".
- Chart types include ColumnClustered, BarClustered, Line, Pie, XYScatter, Area.
- Before an edit, briefly say what you're about to change. After editing, confirm what changed.
- If the user has editing set to "off" or declines a confirmation, a tool returns
  {skipped:true}. Explain what you would have done and how to enable editing.

Memory:
- You have a per-user memory. Durable facts the user has told you are provided to you
  under a heading like "[Vad du minns om användaren]". Use them to personalize your help
  without being asked again (their name, role, language quirks, recurring tasks,
  preferred formats, domain terminology, the structure of their workbooks).
- When the user tells you something worth remembering for next time, call the remember
  tool with a short note. Save preferences and stable facts only — not one-off requests.
  Never store passwords, API keys, or other secrets.
- Keep notes short and specific (one fact each). If something you remember is now wrong,
  save the corrected version.

Building well-structured output:
When you create something (a table, summary, report, schedule, budget, or model),
make it look deliberate and professional, not a raw dump of values. Follow this recipe:
1. Plan the layout before writing: a title, a header row, the data, and a totals row.
   Leave a one-cell margin — start at B2 rather than A1 — and don't crowd sections together.
2. Write the whole block in as few write_range/set_formulas calls as possible (see batching below).
3. Header row: bold, a solid fill in the accent color, a contrasting (usually white) font,
   and centered. Then freeze_panes on the header row so it stays visible.
4. Number formats by column meaning: money "#,##0" or "#,##0 kr", percentages "0.0%",
   large counts "#,##0", dates "yyyy-mm-dd". Apply per column, not to the whole block.
5. Totals/summary row: bold, a top border (format_range border "top"), and SUM/AVERAGE
   formulas rather than hard-coded numbers.
6. Use a thin outline or bottom border under the header to separate sections.
7. Title: a larger, bold cell, optionally merged across the table width with merge_cells.
8. Finish every build with autofit, then select_range on the result so the user sees it.
Use a consistent accent color throughout (a calm blue/green works well). Prefer real
formulas over static values so the sheet stays live. For a list the user will grow, use
create_table instead of manual formatting.

- Batch your edits: each edit asks the user for confirmation, so minimize the
  number of edit tool calls. Write a whole region in ONE write_range/set_formulas
  call instead of many single-cell calls, and combine formatting where you can.
  Prefer the fewest edit calls that get the job done. Keep replies concise and practical.`;

const TOOLS = [
  { name: "get_selection", description: "Get the address, dimensions, values, and formulas of the user's currently selected range.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "read_range", description: "Read a specific A1-style range, e.g. 'A1:C20' or 'Sheet2!A1:B5'. Set include_formulas to also get formulas and number formats.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range address." },
      include_formulas: { type: "boolean", description: "Also return formulas and number formats." },
    }, required: ["address"] } },

  { name: "get_sheet_info", description: "Get the active sheet name and its used-range dimensions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "list_sheets", description: "List all worksheets (name, position, visibility) and which one is active.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "find", description: "Find cells whose value contains the query text. Returns matching cell addresses (active sheet).",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "Text to search for." },
      match_case: { type: "boolean", description: "Case-sensitive match (default false)." },
    }, required: ["query"] } },

  { name: "write_range", description: "Write a 2D array of values into a range. The array shape must match the range.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style target range." },
      values: { type: "array", description: "2D array of cell values (rows of columns).", items: { type: "array", items: {} } },
    }, required: ["address", "values"] } },

  { name: "set_formula", description: "Set a single Excel formula across every cell in a range, e.g. address 'D2:D100', formula '=B2*C2'.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style target range." },
      formula: { type: "string", description: "Excel formula starting with '='." },
    }, required: ["address", "formula"] } },

  { name: "set_formulas", description: "Set a 2D array of per-cell formulas into a range (shape must match the range).",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style target range." },
      formulas: { type: "array", description: "2D array of formula strings.", items: { type: "array", items: { type: "string" } } },
    }, required: ["address", "formulas"] } },

  { name: "clear_range", description: "Clear a range's contents, formats, or both.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
      what: { type: "string", enum: ["contents", "formats", "all"], description: "What to clear (default contents)." },
    }, required: ["address"] } },

  { name: "format_range", description: "Apply formatting to a range: number format, bold/italic/underline, font size, font/fill color, alignment, wrap, cell borders, and column width. Use it to style header rows (bold + fill), totals rows (bold + top border), and to set per-column number formats.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
      number_format: { type: "string", description: "Excel number format, e.g. '#,##0.00' or '0.0%' or '#,##0 kr'." },
      bold: { type: "boolean" }, italic: { type: "boolean" }, underline: { type: "boolean" },
      font_color: { type: "string", description: "Hex color like '#1F7A4D'." },
      fill_color: { type: "string", description: "Hex background color." },
      font_size: { type: "number" },
      align: { type: "string", enum: ["left", "center", "right"] },
      wrap: { type: "boolean" },
      border: { type: "string", enum: ["none", "top", "bottom", "outline", "all"], description: "Add borders: 'top' for a totals separator, 'bottom' under a header, 'outline' around the block, 'all' for a full grid." },
      border_color: { type: "string", description: "Hex border color (default a medium gray)." },
      column_width: { type: "number", description: "Set column width in POINTS (Excel default is about 48; use 90-150 to make columns wider)." },
    }, required: ["address"] } },

  { name: "insert_rows", description: "Insert blank rows above a given row index (1-based).",
    input_schema: { type: "object", properties: {
      index: { type: "integer", description: "1-based row number to insert above." },
      count: { type: "integer", description: "How many rows (default 1)." },
    }, required: ["index"] } },

  { name: "delete_rows", description: "Delete rows starting at a given row index (1-based).",
    input_schema: { type: "object", properties: {
      index: { type: "integer", description: "1-based starting row number." },
      count: { type: "integer", description: "How many rows (default 1)." },
    }, required: ["index"] } },

  { name: "insert_columns", description: "Insert blank columns before a given column letter.",
    input_schema: { type: "object", properties: {
      column: { type: "string", description: "Column letter, e.g. 'C'." },
      count: { type: "integer", description: "How many columns (default 1)." },
    }, required: ["column"] } },

  { name: "delete_columns", description: "Delete columns starting at a given column letter.",
    input_schema: { type: "object", properties: {
      column: { type: "string", description: "Column letter, e.g. 'C'." },
      count: { type: "integer", description: "How many columns (default 1)." },
    }, required: ["column"] } },

  { name: "sort_range", description: "Sort a range by one of its columns.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range to sort." },
      column_index: { type: "integer", description: "0-based column within the range to sort by (default 0)." },
      ascending: { type: "boolean", description: "Ascending order (default true)." },
      has_headers: { type: "boolean", description: "Treat the first row as headers (default true)." },
    }, required: ["address"] } },

  { name: "autofit", description: "Autofit column widths and row heights for a range. Call this at the end of anything you build so nothing is clipped.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
    }, required: ["address"] } },

  { name: "set_column_width", description: "Set the width of one or more columns, in POINTS (Excel default is about 48; to make columns WIDER use a larger value like 90-150). Or pass autofit to size to content. Accepts a column range like 'A:D' or any A1 range whose columns you want to size.",
    input_schema: { type: "object", properties: {
      columns: { type: "string", description: "Column range like 'A:D', a single column 'B:B', or an A1 range like 'B2:E2'." },
      width: { type: "number", description: "Width in points. Larger is wider. Ignored when autofit is true." },
      autofit: { type: "boolean", description: "Size columns to their content instead of a fixed width." },
    }, required: ["columns"] } },

  { name: "set_row_height", description: "Set the height of one or more rows, in points, or autofit to content. Accepts a row range like '1:1' or any A1 range whose rows you want to size.",
    input_schema: { type: "object", properties: {
      rows: { type: "string", description: "Row range like '1:1', '2:10', or an A1 range like 'B2:E2'." },
      height: { type: "number", description: "Height in points. Ignored when autofit is true." },
      autofit: { type: "boolean", description: "Size rows to their content instead of a fixed height." },
    }, required: ["rows"] } },

  { name: "remember", description: "Save a short, durable fact about the user to your per-user memory so you recall it in future chats (e.g. their name, role, preferred formats, recurring tasks, domain terms). Use for stable preferences and facts only, never one-off requests or secrets.",
    input_schema: { type: "object", properties: {
      note: { type: "string", description: "A single short fact to remember, phrased so it is useful later." },
    }, required: ["note"] } },

  { name: "merge_cells", description: "Merge a range into a single cell. Use for a title banner spanning the columns of a table, then center and enlarge it with format_range.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range to merge, e.g. 'B2:E2'." },
      across: { type: "boolean", description: "Merge each row separately (true) or the whole range into one cell (default false)." },
    }, required: ["address"] } },

  { name: "freeze_panes", description: "Freeze the top rows and/or leading columns so headers stay visible while scrolling. Call after building any table taller than a screen. Pass rows 0 and columns 0 to unfreeze.",
    input_schema: { type: "object", properties: {
      rows: { type: "integer", description: "Number of top rows to freeze (e.g. 1 for a header row)." },
      columns: { type: "integer", description: "Number of leading columns to freeze." },
    } } },

  { name: "create_table", description: "Convert a range into an Excel table (banded rows, filter buttons, auto-expanding). Prefer this for any list or dataset the user will keep adding rows to.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range including headers." },
      has_headers: { type: "boolean", description: "First row is headers (default true)." },
      name: { type: "string", description: "Optional table name." },
    }, required: ["address"] } },

  { name: "create_chart", description: "Add a chart built from a data range.",
    input_schema: { type: "object", properties: {
      data_range: { type: "string", description: "A1-style range of the chart data." },
      chart_type: { type: "string", description: "e.g. ColumnClustered, BarClustered, Line, Pie, XYScatter, Area." },
      title: { type: "string", description: "Optional chart title." },
    }, required: ["data_range"] } },

  { name: "add_sheet", description: "Add a new worksheet and make it active.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "Optional sheet name." },
    } } },

  { name: "select_range", description: "Select/navigate to a range so the user can see it. Always finish a build by selecting the result.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
    }, required: ["address"] } },
];

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

// Single-deployable mode: if a production build exists, serve the sidebar
// (dist/) from this same service so the front-end and /api share one origin —
// no second host, no CORS, and API_BASE="" works as-is. In development the
// webpack dev server serves the front-end instead and dist/ may be absent.
const serveStatic = existsSync(DIST_DIR);
if (serveStatic) {
  app.use(express.static(DIST_DIR));
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    keyConfigured: Boolean(apiKey),
    ssoConfigured,
    memoryStore: usingPostgres ? "postgres" : "ephemeral",
  });
});

// ---- Per-user memory (Microsoft 365 identity required) --------------------
// GET returns the signed-in user's saved notes; PUT replaces them. Both require
// a valid Office SSO token; without SSO/DB the client keeps memory on-device.
async function requireUser(req, res) {
  try {
    return await verifyToken(bearer(req));
  } catch (err) {
    const status = err.status || 401;
    res.status(status).json({ error: err.message || "Not authorized.", ssoConfigured });
    return null;
  }
}

app.get("/api/memory", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    res.json({ notes: await getMemory(user.key), user: { name: user.name, email: user.email } });
  } catch (err) {
    console.error("[Simba] memory read failed:", err?.message || err);
    res.status(502).json({ error: "Could not read memory." });
  }
});

app.put("/api/memory", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const notes = req.body?.notes;
  if (notes != null && !Array.isArray(notes))
    return res.status(400).json({ error: "'notes' must be an array of strings." });
  try {
    res.json({ notes: await setMemory(user.key, notes || []) });
  } catch (err) {
    console.error("[Simba] memory write failed:", err?.message || err);
    res.status(502).json({ error: "Could not save memory." });
  }
});

// ---- Fail-safes: input validation + a lightweight global rate limit ----
// These protect your Anthropic spend from runaway loops or abuse. Tune via env.
const RPM = Number(process.env.SIMBA_RPM || 60);                  // requests/min (global)
const MAX_CONCURRENT = Number(process.env.SIMBA_CONCURRENCY || 6);
const MAX_MESSAGES = Number(process.env.SIMBA_MAX_MESSAGES || 200);
const MAX_CHARS = Number(process.env.SIMBA_MAX_CHARS || 1_500_000);
let hits = [];
let inflight = 0;

// ---- Speed controls -------------------------------------------------------
// The client sends a per-request speed preference; we map it to thinking effort
// and (optionally) fast mode. Lower effort and fast mode trade some depth for
// noticeably quicker answers. Default is tunable via SIMBA_SPEED.
const DEFAULT_SPEED = process.env.SIMBA_SPEED || "balanced";
const SPEED_MAP = {
  thorough: { effort: "high", fast: false },
  balanced: { effort: "medium", fast: false },
  fast: { effort: "medium", fast: true },
};

// Cache the large, static system prompt + tool definitions so every turn after
// the first skips re-processing them (faster time-to-first-token, lower cost).
// Per-user memory is appended as a second block AFTER the cache breakpoint, so it
// can vary per user without invalidating the shared, cached prefix.
const MAX_MEMORY_CHARS = 4000;
function buildSystem(memory) {
  const blocks = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
  const mem = sanitizeMemory(memory);
  if (mem) blocks.push({ type: "text", text: `[Vad du minns om användaren]\n${mem}` });
  return blocks;
}
function sanitizeMemory(memory) {
  let notes = [];
  if (Array.isArray(memory)) notes = memory;
  else if (typeof memory === "string" && memory.trim()) notes = memory.split("\n");
  notes = notes.map((n) => String(n).trim()).filter(Boolean).slice(0, 50);
  if (!notes.length) return "";
  let text = notes.map((n) => `- ${n}`).join("\n");
  if (text.length > MAX_MEMORY_CHARS) text = text.slice(0, MAX_MEMORY_CHARS);
  return text;
}

// Add a cache breakpoint on the last message so the growing conversation prefix
// is reused on the next turn (the agent loop re-sends full history each time).
function withConversationCache(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  const out = messages.slice();
  const last = { ...out[out.length - 1] };
  let content = last.content;
  if (typeof content === "string") content = [{ type: "text", text: content }];
  else if (Array.isArray(content)) content = content.map((b) => ({ ...b }));
  else return messages;
  const tail = content[content.length - 1];
  if (tail && typeof tail === "object") {
    content[content.length - 1] = { ...tail, cache_control: { type: "ephemeral" } };
    last.content = content;
    out[out.length - 1] = last;
  }
  return out;
}

// Run the model for one turn, honoring the speed preference. Streams text to
// `onText` as it's generated, and returns the assembled final message (content
// blocks + stop_reason) for the task pane's agent loop. Fast mode runs on the
// beta endpoint and has its own rate limit, so we fall back to standard speed if
// it errors BEFORE any text was streamed (otherwise we can't cleanly recover).
async function runModel(messages, speed, memory, onText) {
  const cfg = SPEED_MAP[speed] || SPEED_MAP[DEFAULT_SPEED] || SPEED_MAP.balanced;
  const base = {
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: cfg.effort },
    system: buildSystem(memory),
    tools: TOOLS,
    messages: withConversationCache(messages),
  };
  let emitted = false;
  const run = async (params, beta) => {
    const s = (beta ? client.beta.messages : client.messages).stream(params);
    s.on("text", (t) => { emitted = true; if (onText) onText(t); });
    return await s.finalMessage();
  };
  if (cfg.fast) {
    try {
      return await run({ ...base, speed: "fast", betas: ["fast-mode-2026-02-01"] }, true);
    } catch (e) {
      if (emitted) throw e; // already streamed output — don't restart
      console.warn("[Simba] fast mode unavailable, using standard speed:", e?.status || e?.message);
    }
  }
  return await run(base);
}

function rateLimited() {
  const now = Date.now();
  hits = hits.filter((t) => now - t < 60_000);
  if (hits.length >= RPM) return true;
  hits.push(now);
  return false;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0)
    return "Request body must include a non-empty 'messages' array.";
  if (messages.length > MAX_MESSAGES) return `Too many messages (max ${MAX_MESSAGES}).`;
  let chars = 0;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant" && m.role !== "system"))
      return "Each message must have role 'user', 'assistant', or 'system'.";
    if (m.content == null) return "Each message must include content.";
    chars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  }
  if (chars > MAX_CHARS) return "Conversation is too large — start a new chat.";
  return null;
}

app.post("/api/chat", async (req, res) => {
  if (!apiKey) return res.status(503).json({ error: "Server is missing ANTHROPIC_API_KEY." });

  const invalid = validateMessages(req.body?.messages);
  if (invalid) return res.status(400).json({ error: invalid });

  if (rateLimited()) {
    res.set("Retry-After", "30");
    return res.status(429).json({ error: "Simba is handling a lot right now. Please retry in a moment." });
  }
  if (inflight >= MAX_CONCURRENT) {
    res.set("Retry-After", "5");
    return res.status(429).json({ error: "Too many requests in flight. Please retry shortly." });
  }

  inflight++;
  // Stream the reply to the task pane as Server-Sent Events: `delta` events carry
  // text as it's generated (token-by-token feel), then one `final` event carries
  // the assembled content blocks + stop_reason for the agent loop to act on.
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // don't let proxies buffer the stream
  });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const final = await runModel(req.body.messages, req.body.speed, req.body.memory, (t) => send("delta", { text: t }));
    send("final", {
      content: final.content,
      stop_reason: final.stop_reason,
      usage: final.usage,
      model: final.model,
    });
  } catch (err) {
    console.error("[Simba] /api/chat error:", err?.message || err);
    send("error", { error: err?.message || "Claude API request failed." });
  } finally {
    inflight--;
    res.end();
  }
});

// Unknown API routes return JSON, not the SPA/HTML.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Central error handler — always returns JSON (covers malformed JSON bodies, oversized payloads, etc.).
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 400;
  console.error("[Simba] request error:", err?.message || err);
  const msg = err?.type === "entity.too.large" ? "Request too large." : "Bad request.";
  res.status(status).json({ error: msg });
});

const server = app.listen(PORT, () => {
  console.log(`[Simba] listening on http://localhost:${PORT}  (model: ${MODEL})`);
  console.log(
    serveStatic
      ? `[Simba] serving the sidebar from ${DIST_DIR} (single-origin mode)`
      : `[Simba] no dist/ build found — API only (dev: webpack serves the sidebar)`
  );
  console.log(
    `[Simba] SSO: ${ssoConfigured ? "on" : "off (device-local memory)"} · memory store: ${usingPostgres ? "postgres" : "ephemeral"}`
  );
});

// Keep the process alive on unexpected errors; shut down cleanly on SIGTERM.
process.on("unhandledRejection", (reason) => console.error("[Simba] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[Simba] uncaughtException:", err));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
