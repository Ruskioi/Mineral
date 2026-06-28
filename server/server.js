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

You have a full set of tools to read, analyze, and edit the workbook. Use them rather
than guessing about the user's data — read first, then act.

Reading & analysis:
- get_selection / read_range — read values (and optionally formulas) of the selection or any range.
- get_sheet_info / list_sheets — inspect the active sheet or enumerate all sheets.
- find — locate cells containing text.

Editing:
- write_range / set_formula / set_formulas — write values or formulas.
- format_range — number formats, bold/italic/underline, font size, font & fill color, alignment, wrap.
- clear_range — clear contents, formats, or both.
- insert_rows / delete_rows / insert_columns / delete_columns — change structure.
- sort_range — sort a range by a column.
- autofit — size columns/rows to content.
- create_table — turn a range into an Excel table.
- create_chart — add a chart from a data range.
- add_sheet — create a new worksheet.
- select_range — move the user's selection / navigate (use to show the user where you worked).

Guidelines:
- Range addresses are A1-style ("B2:D10"), optionally sheet-qualified ("Sheet2!A1:C3").
- The user's current selection is often appended to their message as
  "[Current selection: ...]". Prefer it when they say "this", "here", "the selection".
- write_range takes a 2D array matching the target shape; set_formula broadcasts one
  formula across a range; set_formulas takes a 2D array of per-cell formulas.
- Colors are hex strings like "#1F7A4D". Alignment is "left" | "center" | "right".
- Chart types include ColumnClustered, BarClustered, Line, Pie, XYScatter, Area.
- Before an edit, briefly say what you're about to change. After editing, confirm what changed.
- If the user has editing set to "off" or declines a confirmation, a tool returns
  {skipped:true}. Explain what you would have done and how to enable editing.
- Prefer multiple precise tool calls over one vague change. Keep replies concise and practical.`;

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

  { name: "format_range", description: "Apply formatting to a range: number format, bold/italic/underline, font size, font/fill color, alignment, wrap.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
      number_format: { type: "string", description: "Excel number format, e.g. '#,##0.00' or '0.0%' or '$#,##0'." },
      bold: { type: "boolean" }, italic: { type: "boolean" }, underline: { type: "boolean" },
      font_color: { type: "string", description: "Hex color like '#1F7A4D'." },
      fill_color: { type: "string", description: "Hex background color." },
      font_size: { type: "number" },
      align: { type: "string", enum: ["left", "center", "right"] },
      wrap: { type: "boolean" },
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

  { name: "autofit", description: "Autofit column widths and row heights for a range.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
    }, required: ["address"] } },

  { name: "create_table", description: "Convert a range into an Excel table.",
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

  { name: "select_range", description: "Select/navigate to a range so the user can see it.",
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
  res.json({ ok: true, model: MODEL, keyConfigured: Boolean(apiKey) });
});

app.post("/api/chat", async (req, res) => {
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY." });
  }
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'messages' array." });
  }

  try {
    // Stream so large/long responses don't hit HTTP timeouts; collect the
    // final assembled message (content blocks + stop_reason) for the task pane.
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    const final = await stream.finalMessage();
    res.json({
      content: final.content,
      stop_reason: final.stop_reason,
      usage: final.usage,
      model: final.model,
    });
  } catch (err) {
    console.error("[Simba] /api/chat error:", err?.message || err);
    const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ error: err?.message || "Claude API request failed." });
  }
});

app.listen(PORT, () => {
  console.log(`[Simba] listening on http://localhost:${PORT}  (model: ${MODEL})`);
  console.log(
    serveStatic
      ? `[Simba] serving the sidebar from ${DIST_DIR} (single-origin mode)`
      : `[Simba] no dist/ build found — API only (dev: webpack serves the sidebar)`
  );
});
