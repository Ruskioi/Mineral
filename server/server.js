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
import { getMemory, setMemory, usingPostgres, listConversations, getConversation, saveConversation, deleteConversation, renameConversation } from "./store.js";
import { randomUUID } from "node:crypto";
import { graphConfigured, oboGraphToken, searchFiles, downloadFile, itemDriveInfo } from "./graph.js";
import { listJobs, createJob, updateJob, deleteJob, getJobOwned } from "./jobs.js";
import { startScheduler, schedulerEnabled } from "./scheduler.js";
import { chooseModel } from "./router.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "../dist");

const PORT = process.env.PORT || 3001;
const MODEL = process.env.SIMBA_MODEL || "claude-opus-4-8";
// Cheaper/faster model for simple turns. An automatic router (chooseModel) sends
// plain conversational questions here and keeps Opus for sheet work, tool use,
// attachments, and longer/complex prompts. Toggle with SIMBA_ROUTER=0.
const MODEL_SIMPLE = process.env.SIMBA_MODEL_SIMPLE || "claude-haiku-4-5-20251001";
const ROUTER_ON = process.env.SIMBA_ROUTER !== "0";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error(
    "\n[Simba] ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.\n"
  );
}

const client = new Anthropic({ apiKey });

const SYSTEM_PROMPT = `You are Simba — a capable, friendly general-purpose AI assistant in the spirit of Claude.
Your mascot is a friendly Pomeranian. You help the user with ANYTHING: answering questions,
explaining things, thinking through problems, writing and editing text and code, researching
the web, analyzing data and running code, generating documents, and working with their files.
Be genuinely helpful, clear, and warm; give complete, well-structured answers; and reason
carefully before you act.

You run on two surfaces that share the same brain, memory, and conversation history:
- As a STANDALONE app (desktop/web) — a full general assistant for any task.
- Inside MICROSOFT EXCEL — where you additionally get deep, direct access to read and edit
  the user's live workbook (the spreadsheet tools below).
The current surface is given to you in a [Läge] note; use the tools available there. Don't tell
the user to switch surfaces unless they specifically need live spreadsheet editing.

ALWAYS respond in Swedish (svenska). Every message you write to the user must be in Swedish, no matter what language they use. Keep code, formula syntax, and cell references unchanged.

Use your tools rather than guessing — research, read, or run code first, then answer. When the
user's request is about a spreadsheet, read it before acting.

Reading & analysis:
- get_selection / read_range — read values (and optionally formulas) of the selection or any range.
- get_sheet_info / list_sheets — inspect the active sheet or enumerate all sheets.
- describe_workbook — one-call overview of every sheet (headers, dimensions, tables,
  charts) and all named ranges. Call this FIRST when asked to explain, summarize, or
  get an overview of a workbook, then read individual ranges for detail.
- find — locate cells containing text.
- capture_view — take a picture of a range/chart and SEE it. Use it to judge
  visual layout, alignment, colours, and chart readability, or to double-check
  how your formatting actually looks. Don't guess about appearance — look.
- analyze_data — run Python (pandas/numpy) on a range for analysis that formulas
  can't do well: forecasting, correlation, anomaly/outlier detection, trends.
- web_lookup — look up current facts on the web (prices, FX, company data) with
  sources, when the answer isn't in the sheet.
- create_document — generate a downloadable PowerPoint, Word, Excel or PDF from
  instructions (decks, reports, memos). Put the actual data/figures in the
  instructions; the file is returned for download, not written into the sheet.

Attached files: the user can attach a file to their message. It arrives inline as
an image, a PDF document, or text (e.g. a CSV). Read it directly. When it's tabular
data the user likely wants it in the sheet — offer to import it with write_range
(into the current selection or a sensible empty area), well-structured.

Cloud files: the user's OneDrive/SharePoint files are reachable with list_files
(search by name) and open_file (read by id). Use them when the user refers to a
file they have in Microsoft 365 rather than one they attached.

Scheduled jobs: with schedule_task you can set up a RECURRING job that runs on its
own server-side — even when Excel is closed — against a OneDrive/SharePoint workbook
(e.g. "every Monday 08:00, refresh the dashboard and append today's totals"). The job
re-runs your instruction on a schedule, so write a complete, self-contained prompt
(it can't see this chat). First find the file with list_files to get its id, then
confirm the schedule and the target file with the user before calling schedule_task.
Use list_schedules to show what's set up and how the last run went, and cancel_schedule
to remove one. By default the user is emailed a short summary after each run (set
notify:false to turn that off). Note: a scheduled run edits the file directly and cannot
recalc formulas until a person opens it, so have the job write concrete values where it needs them.

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
- list_charts / update_chart — list existing charts, then improve one (type, title, legend,
  data labels, axis titles, series colours). To improve a chart: list_charts for its name,
  capture_view to SEE it, then update_chart — and capture_view again to confirm it looks right.
- trace_cell — show a cell's direct precedents and dependents. Use to debug formulas:
  when a number looks wrong or the user asks what affects/depends on a cell, trace it.
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

Working on large tasks (plan & delegate):
- For a BIG job (roughly 4+ edits, or one that reshapes the sheet — a full report,
  model, or dashboard), call propose_plan FIRST with a short numbered plan and wait
  for approval. If approved, execute it; if declined, ask what to change. Skip planning
  for small, obvious requests — just do them.
- You can split a big job into independent pieces with delegate_task: each runs as a
  focused subagent with the same tools and returns a short result. Good for parts that
  stand alone (e.g. "build the summary sheet", "make the four regional charts"). The
  subagent can't see this chat, so put everything it needs in task/context. Don't
  delegate trivial one-step actions — do those yourself. Keep doing the orchestration
  (planning, sequencing, final summary) in the main thread.

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
7. Title: a larger, bold cell. If you merge it across the table width with merge_cells,
   WRITE THE TITLE TEXT INTO THE TOP-LEFT cell of the merge range first (e.g. put it in
   B2 before merging B2:E2). Merging keeps only the top-left cell — a title placed in a
   middle cell is destroyed by the merge. Then center it with format_range.
8. Finish every build with autofit, then select_range on the result so the user sees it.
Use a consistent accent color throughout (a calm blue/green works well). Prefer real
formulas over static values so the sheet stays live. For a list the user will grow, use
create_table instead of manual formatting.

Do NOT destroy your own work when finishing. The ONLY clean-up steps at the end are
autofit and select_range. Never run clear_range over a region that holds your title,
headers, or data, and never re-write a range in a way that blanks the title. If you
reformat at the end, use format_range (it changes look, not content) — don't clear or
overwrite cells that already have the right values.

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

  { name: "describe_workbook", description: "Survey the WHOLE workbook in one call: every sheet's used range, dimensions, column headers, tables and chart counts, plus all workbook named ranges. Use this first when the user asks you to explain, summarize, or get an overview of a workbook you haven't read yet.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "find", description: "Find cells whose value contains the query text. Returns matching cell addresses (active sheet).",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "Text to search for." },
      match_case: { type: "boolean", description: "Case-sensitive match (default false)." },
    }, required: ["query"] } },

  { name: "capture_view", description: "Take a picture of a range (or the current selection) and SEE it, so you can judge layout, alignment, colours, spacing, and charts the way a person would. Use it when the user asks how something looks, to review a chart, or to visually verify your own formatting.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range to capture; omit to capture the current selection." },
    } } },

  { name: "trace_cell", description: "Trace a formula cell's relationships: its direct precedents (cells it reads from) and direct dependents (cells that read from it), plus its own formula and value. Use to debug formulas — to answer 'which cells affect this?' or 'what depends on this?' and to find where a wrong number comes from.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style cell to trace (the top-left cell is used if a range is given)." },
    }, required: ["address"] } },

  { name: "list_charts", description: "List the charts on the active sheet (name and chart type). Use to find a chart's name before updating it with update_chart.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "analyze_data", description: "Run a deeper statistical analysis on a range using Python (pandas/numpy) on the server — for things plain formulas can't easily do: forecasting, trend/seasonality, correlation, outlier/anomaly detection, distributions. Returns a written analysis in Swedish; it does NOT modify the sheet, so write any results back yourself if asked.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range of the data to analyze (include headers)." },
      question: { type: "string", description: "What to find out, e.g. forecast next quarter, or flag outliers in column C." },
    }, required: ["address"] } },

  { name: "run_code", description: "Run Python on the server (a real sandbox with pandas/numpy and more) to compute, transform, or reason precisely about anything — math, data wrangling, parsing, simulations, generating or checking results. Use whenever exact computation beats estimating in your head, or to process data the user gives you. Returns the textual result/answer in Swedish; it does not write to the sheet.",
    input_schema: { type: "object", properties: {
      task: { type: "string", description: "What to compute or do, described clearly." },
      data: { type: "string", description: "Optional input data (CSV, JSON, text) the code should work on." },
    }, required: ["task"] } },

  { name: "web_lookup", description: "Look up current real-world information on the web (prices, FX rates, company facts, definitions, recent events) and get a concise answer with sources. Use when the answer depends on up-to-date data not in the sheet. Returns text; write it into cells yourself if the user wants it in the sheet.",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "The question to research, phrased clearly." },
    }, required: ["query"] } },

  { name: "create_document", description: "Generate a polished file the user can download — a PowerPoint (pptx), Word (docx), Excel (xlsx) or PDF — from instructions. Use for requests like make a deck/report/memo from this. Give clear, detailed instructions (and include the data/figures to use). Returns the file for download; it is NOT written into the current sheet.",
    input_schema: { type: "object", properties: {
      kind: { type: "string", enum: ["pptx", "docx", "xlsx", "pdf"], description: "File type to produce." },
      instructions: { type: "string", description: "What the document should contain — structure, sections, data, tone. Be specific." },
    }, required: ["kind", "instructions"] } },

  { name: "list_files", description: "List or search the signed-in user's OneDrive/SharePoint files (Microsoft 365). Use when the user refers to a file by name or asks to open/import something from their cloud storage. Returns id + name for each; pass the id to open_file.",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "Search text (file name/keywords). Omit to list recent files." },
    } } },

  { name: "open_file", description: "Open a OneDrive/SharePoint file by id (from list_files) and read its contents — text/CSV is returned as text, images and PDFs are returned so you can see/read them. For tabular data, offer to import it into the sheet with write_range.",
    input_schema: { type: "object", properties: {
      id: { type: "string", description: "The file id from list_files." },
      name: { type: "string", description: "Optional file name, for display." },
    }, required: ["id"] } },

  { name: "schedule_task", description: "Set up a RECURRING job that Simba runs on its own (server-side, even when Excel is closed) against a OneDrive/SharePoint workbook — e.g. 'every Monday 08:00, refresh the dashboard with current FX and add today's totals'. Use list_files first to get the file id. Requires Microsoft sign-in. Confirm the schedule and target with the user before creating it.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "A short label for the schedule." },
      prompt: { type: "string", description: "The full, self-contained instruction the job runs each time (it does not see this chat)." },
      file_id: { type: "string", description: "The target workbook's id from list_files." },
      freq: { type: "string", description: "daily | weekdays | weekly | monthly | once." },
      time: { type: "string", description: "Local time HH:MM (default 09:00)." },
      weekday: { type: "integer", description: "For weekly: 0=Sunday … 6=Saturday." },
      monthday: { type: "integer", description: "For monthly: day of month 1-31." },
      on_date: { type: "string", description: "For once: YYYY-MM-DD." },
      notify: { type: "boolean", description: "Email the user a summary after each run (default true)." },
    }, required: ["prompt", "file_id"] } },

  { name: "list_schedules", description: "List the user's scheduled jobs (name, schedule, target file, next run, last result). Use when they ask what's scheduled or how a job went.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "cancel_schedule", description: "Delete a scheduled job by id (from list_schedules).",
    input_schema: { type: "object", properties: { id: { type: "string", description: "The schedule id." } }, required: ["id"] } },

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

  { name: "propose_plan", description: "Before a LARGE multi-step task (roughly 4+ edits, or a build that reshapes the sheet), present a short numbered plan and get the user's go-ahead. Returns {approved}. If approved, carry out the plan; if not, ask what to change instead of re-proposing the same plan. Skip this for small, obvious tasks.",
    input_schema: { type: "object", properties: {
      title: { type: "string", description: "A one-line summary of what you'll do." },
      steps: { type: "array", description: "The ordered steps you intend to take, each a short sentence.", items: { type: "string" } },
    }, required: ["title", "steps"] } },

  { name: "delegate_task", description: "Hand a single, self-contained sub-task to a focused subagent that works on its own (with the same tools) and returns a short result. Use to break a big job into independent parts (e.g. 'build the summary sheet', 'create the regional charts') so each runs with clean focus. Don't delegate trivial one-step actions; do them yourself.",
    input_schema: { type: "object", properties: {
      task: { type: "string", description: "The complete, self-contained instruction for the subagent." },
      context: { type: "string", description: "Optional facts the subagent needs (addresses, names, conventions) since it does not see this conversation." },
    }, required: ["task"] } },

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

  { name: "update_chart", description: "Improve an EXISTING chart: change its type, title, legend, data labels, axis titles, or series colours. Use after list_charts (for the name) and capture_view (to see it) when the user asks to fix or improve a chart's look.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "The chart's name (from list_charts)." },
      chart_type: { type: "string", description: "New type, e.g. ColumnClustered, BarClustered, Line, Pie, XYScatter, Area." },
      title: { type: "string", description: "Chart title text." },
      show_legend: { type: "boolean", description: "Show or hide the legend." },
      legend_position: { type: "string", description: "Legend position: Top, Bottom, Left, Right." },
      show_data_labels: { type: "boolean", description: "Show or hide data labels on the series." },
      x_axis_title: { type: "string", description: "Category (X) axis title." },
      y_axis_title: { type: "string", description: "Value (Y) axis title." },
      series_colors: { type: "array", description: "Hex colours (e.g. #2E7D32) applied to each series in order.", items: { type: "string" } },
    }, required: ["name"] } },

  { name: "find_errors", description: "Scan the active sheet for formula errors (#REF!, #DIV/0!, #VALUE!, #NAME?, #N/A, #NULL!, #NUM!) and return the cells that contain them. Use when the user asks what's broken or to fix errors.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "conditional_formatting", description: "Add conditional formatting to a range: data bars, a red-yellow-green colour scale, a highlight rule (cells greater/less/equal than a value), or highlight duplicates. Use to make data easier to read at a glance.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
      type: { type: "string", enum: ["data_bar", "color_scale", "greater_than", "less_than", "equal_to", "duplicates"], description: "Kind of rule." },
      value: { type: "number", description: "Threshold for greater_than/less_than/equal_to." },
      color: { type: "string", description: "Hex highlight/fill colour for the rule (e.g. '#FFC7CE')." },
    }, required: ["address", "type"] } },

  { name: "data_validation", description: "Add a dropdown list (data validation) to a range so users can only pick from set options. Use for status columns, categories, yes/no, etc.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range to apply the dropdown to." },
      values: { type: "array", description: "Allowed options.", items: { type: "string" } },
    }, required: ["address", "values"] } },

  { name: "add_comment", description: "Attach a comment/note to a cell (e.g. an explanation or a flag for the user).",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style single cell." },
      text: { type: "string", description: "Comment text." },
    }, required: ["address", "text"] } },

  { name: "create_pivot_table", description: "Build a PivotTable summarizing a data range. Specify which header fields go on rows, columns, and values (values are summed). Use for grouped summaries like sales by region, totals by category.",
    input_schema: { type: "object", properties: {
      source_range: { type: "string", description: "A1-style range of the source data INCLUDING headers." },
      destination: { type: "string", description: "A1-style top-left cell where the pivot goes (a clear area, often on another sheet)." },
      rows: { type: "array", description: "Header field names to put on rows.", items: { type: "string" } },
      values: { type: "array", description: "Header field names to summarize (summed).", items: { type: "string" } },
      columns: { type: "array", description: "Optional header field names to put on columns.", items: { type: "string" } },
      name: { type: "string", description: "Optional pivot table name." },
    }, required: ["source_range", "destination", "values"] } },

  { name: "apply_filter", description: "Turn on AutoFilter for a range (filter dropdowns), optionally filtering one column to specific values. Use to show only matching rows.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range including headers." },
      column_index: { type: "integer", description: "0-based column within the range to filter (optional)." },
      values: { type: "array", description: "Values to keep visible in that column (optional).", items: { type: "string" } },
    }, required: ["address"] } },

  { name: "remove_duplicates", description: "Remove duplicate rows from a range (keeps the first of each). Returns how many were removed.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
      columns: { type: "array", description: "0-based column indices to compare (optional; default all).", items: { type: "integer" } },
      has_headers: { type: "boolean", description: "First row is headers (default true)." },
    }, required: ["address"] } },

  { name: "create_named_range", description: "Create a workbook named range so a region can be referenced by a friendly name in formulas (e.g. Sales for B2:B100).",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "The name (letters/digits/underscore, no spaces)." },
      address: { type: "string", description: "A1-style range the name refers to." },
    }, required: ["name", "address"] } },

  { name: "add_sheet", description: "Add a new worksheet and make it active.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "Optional sheet name." },
    } } },

  { name: "select_range", description: "Select/navigate to a range so the user can see it. Always finish a build by selecting the result.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1-style range." },
    }, required: ["address"] } },

  { name: "revert_last_change", description: "Undo the most recent value/formula edit you made (restores the previous cell contents). Use when the user asks to undo, revert, or take it back. Covers write_range/set_formula/set_formulas/clear_range; it does not undo formatting or row/column structure changes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
];

const app = express();
app.set("trust proxy", 1); // behind Render/host proxy — needed for correct req.ip

// CORS is locked down by default: in single-origin hosting the add-in and /api
// share an origin, so no CORS is needed. Set SIMBA_ALLOWED_ORIGINS (comma-list)
// only if you serve the front-end from a different origin.
const ALLOWED_ORIGINS = (process.env.SIMBA_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
if (ALLOWED_ORIGINS.length) app.use(cors({ origin: ALLOWED_ORIGINS }));

// Conservative security headers. NB: do NOT set X-Frame-Options — Office hosts
// the task pane in a webview/iframe and DENY/SAMEORIGIN would break it.
app.use((_req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use(express.json({ limit: "25mb" })); // headroom for attached images/PDFs (base64)

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
    graphConfigured,
    schedulerEnabled,
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

// ---- Shared conversation history (per user, across devices/surfaces) ------
app.get("/api/conversations", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ conversations: await listConversations(user.key) }); }
  catch (err) { console.error("[Simba] conv list failed:", err?.message || err); res.status(502).json({ error: "Could not list conversations." }); }
});

app.post("/api/conversations", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const id = randomUUID();
    await saveConversation(user.key, id, req.body?.title || "", req.body?.messages || []);
    res.json({ id });
  } catch (err) { console.error("[Simba] conv create failed:", err?.message || err); res.status(502).json({ error: "Could not create conversation." }); }
});

app.get("/api/conversations/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const c = await getConversation(user.key, req.params.id);
    if (!c) return res.status(404).json({ error: "Not found." });
    res.json(c);
  } catch (err) { console.error("[Simba] conv get failed:", err?.message || err); res.status(502).json({ error: "Could not load conversation." }); }
});

app.put("/api/conversations/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.body?.messages != null && !Array.isArray(req.body.messages))
    return res.status(400).json({ error: "'messages' must be an array." });
  try {
    // Title-only update (rename) when no messages are sent — must not wipe history.
    if (req.body?.messages === undefined && typeof req.body?.title === "string") {
      return res.json(await renameConversation(user.key, req.params.id, req.body.title));
    }
    res.json(await saveConversation(user.key, req.params.id, req.body?.title || "", req.body?.messages || []));
  } catch (err) { console.error("[Simba] conv save failed:", err?.message || err); res.status(502).json({ error: "Could not save conversation." }); }
});

app.delete("/api/conversations/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { await deleteConversation(user.key, req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("[Simba] conv delete failed:", err?.message || err); res.status(502).json({ error: "Could not delete conversation." }); }
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
function buildSystem(memory, surface) {
  const blocks = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
  const mem = sanitizeMemory(memory);
  if (mem) blocks.push({ type: "text", text: `[Vad du minns om användaren]\n${mem}` });
  if (surface === "desktop") blocks.push({ type: "text", text:
    "[Läge] Du körs som en fristående AI-app (skrivbord/webb) — en fullständig allmän " +
    "assistent. Hjälp till med vad som helst: svara på frågor, skriva och resonera, söka " +
    "på webben (web_lookup), köra kod och analysera data (run_code/analyze_data), skapa " +
    "dokument (create_document: Word/PowerPoint/Excel/PDF), läsa bifogade filer och " +
    "OneDrive/SharePoint-filer (list_files/open_file), schemalägga återkommande jobb " +
    "(schedule_task) och minnas det viktiga (remember). Live-redigering av ett kalkylark " +
    "sker i Excel-tillägget; nämn det bara om användaren uttryckligen vill ändra ett öppet ark." });
  else blocks.push({ type: "text", text:
    "[Läge] Du körs inuti Microsoft Excel. Du har full tillgång till kalkylarksverktygen — " +
    "läs och redigera arket direkt — utöver dina allmänna förmågor (webb, kod, dokument, minne)." });
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
async function runModel(messages, speed, memory, surface, onText) {
  const cfg = SPEED_MAP[speed] || SPEED_MAP[DEFAULT_SPEED] || SPEED_MAP.balanced;
  const model = chooseModel(messages, speed, { strong: MODEL, simple: MODEL_SIMPLE, on: ROUTER_ON });
  const base = {
    model,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: cfg.effort },
    system: buildSystem(memory, surface),
    tools: TOOLS,
    messages: withConversationCache(messages),
  };
  let emitted = false;
  const run = async (params, beta) => {
    const s = (beta ? client.beta.messages : client.messages).stream(params);
    s.on("text", (t) => { emitted = true; if (onText) onText(t); });
    return await s.finalMessage();
  };
  // Fast mode applies to the strong (Opus) model; Haiku is already fast.
  if (cfg.fast && model === MODEL) {
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

// Per-IP limiter so a single abuser can't consume the whole global budget
// (denial-of-wallet). Tune with SIMBA_IP_RPM.
const IP_RPM = Number(process.env.SIMBA_IP_RPM || 15);
const ipHits = new Map();
function ipRateLimited(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter((t) => now - t < 60_000);
  if (arr.length >= IP_RPM) { ipHits.set(ip, arr); return true; }
  arr.push(now);
  ipHits.set(ip, arr);
  if (ipHits.size > 5000) ipHits.clear(); // crude memory cap
  return false;
}

// Optional per-user daily turn cap (org cost guard). Off unless SIMBA_USER_DAILY
// is set. Keyed to the Microsoft identity; in-memory (per instance), resets daily.
const USER_DAILY = Number(process.env.SIMBA_USER_DAILY || 0);
const userQuota = new Map(); // userKey -> { day, n }
function quotaExceeded(userKey) {
  if (!USER_DAILY || !userKey) return false;
  const day = new Date().toISOString().slice(0, 10);
  const q = userQuota.get(userKey);
  if (!q || q.day !== day) { userQuota.set(userKey, { day, n: 1 }); if (userQuota.size > 20000) { /* crude cap */ } return false; }
  if (q.n >= USER_DAILY) return true;
  q.n++;
  return false;
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0)
    return "Request body must include a non-empty 'messages' array.";
  if (messages.length > MAX_MESSAGES) return `Too many messages (max ${MAX_MESSAGES}).`;
  let chars = 0;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant"))
      return "Each message must have role 'user' or 'assistant'.";
    if (m.content == null) return "Each message must include content.";
    // Count only text toward the budget; image/PDF/tool_result blocks are bounded
    // by the request body limit, not this character cap.
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === "text" && typeof b.text === "string") chars += b.text.length;
  }
  if (chars > MAX_CHARS) return "Conversation is too large — start a new chat.";
  return null;
}

app.post("/api/chat", async (req, res) => {
  if (!apiKey) return res.status(503).json({ error: "Server is missing ANTHROPIC_API_KEY." });

  const invalid = validateMessages(req.body?.messages);
  if (invalid) return res.status(400).json({ error: invalid });

  if (ipRateLimited(req.ip)) {
    res.set("Retry-After", "30");
    return res.status(429).json({ error: "För många förfrågningar från den här enheten. Försök igen om en stund." });
  }
  if (rateLimited()) {
    res.set("Retry-After", "30");
    return res.status(429).json({ error: "Simba is handling a lot right now. Please retry in a moment." });
  }
  if (inflight >= MAX_CONCURRENT) {
    res.set("Retry-After", "5");
    return res.status(429).json({ error: "Too many requests in flight. Please retry shortly." });
  }

  // Optional per-user daily cap (only when configured + a valid token is sent).
  if (USER_DAILY && ssoConfigured && bearer(req)) {
    try {
      const u = await verifyToken(bearer(req));
      if (quotaExceeded(u.key)) {
        res.set("Retry-After", "3600");
        return res.status(429).json({ error: "Du har nått din dagliga gräns för Simba. Försök igen imorgon." });
      }
    } catch { /* invalid token → fall back to IP limits */ }
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
    const final = await runModel(req.body.messages, req.body.speed, req.body.memory, req.body.surface, (t) => send("delta", { text: t }));
    send("final", {
      content: final.content,
      stop_reason: final.stop_reason,
      usage: final.usage,
      model: final.model,
    });
  } catch (err) {
    console.error("[Simba] /api/chat error:", err?.message || err); // detail stays server-side
    send("error", { error: "Simba kunde inte slutföra svaret. Försök igen." });
  } finally {
    inflight--;
    res.end();
  }
});

// ---- Server-tool helpers: code execution + web search --------------------
// These run Anthropic's server-side tools inside one isolated call and return
// just the final text, so the task pane's client-side agent loop stays simple.
async function runWithServerTools({ system, content, tools }) {
  const messages = [{ role: "user", content }];
  for (let i = 0; i < 6; i++) {
    const resp = await client.messages.create({ model: MODEL, max_tokens: 8000, system, tools, messages });
    if (resp.stop_reason === "pause_turn") { // server tool still working — resume
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }
  return "Analysen tog för många steg. Försök avgränsa frågan.";
}

function preflight(req, res) {
  if (!apiKey) { res.status(503).json({ error: "Server is missing ANTHROPIC_API_KEY." }); return false; }
  if (ipRateLimited(req.ip) || rateLimited()) { res.set("Retry-After", "30"); res.status(429).json({ error: "För många förfrågningar. Försök igen om en stund." }); return false; }
  return true;
}

// ---- Document generation (PowerPoint/Word/Excel/PDF via Claude Skills) -----
const DOC_SKILL = { pptx: "pptx", powerpoint: "pptx", docx: "docx", word: "docx", xlsx: "xlsx", excel: "xlsx", pdf: "pdf" };
const DOC_MEDIA = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};
function findFileId(content) {
  let id = null;
  const walk = (x) => {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === "object") {
      if (typeof x.file_id === "string") id = x.file_id; // last one wins (final artifact)
      for (const k in x) walk(x[k]);
    }
  };
  walk(content);
  return id;
}
async function generateDocument(skillId, instructions) {
  const messages = [{ role: "user", content: instructions }];
  let last;
  for (let i = 0; i < 8; i++) {
    last = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["code-execution-2025-08-25", "skills-2025-10-02"],
      container: { skills: [{ type: "anthropic", skill_id: skillId, version: "latest" }] },
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      messages,
    });
    if (last.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: last.content }); continue; }
    break;
  }
  const fileId = findFileId(last?.content);
  if (!fileId) {
    const text = (last?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    throw Object.assign(new Error(text || "No document produced."), { status: 502 });
  }
  const dl = await client.beta.files.download(fileId);
  const buffer = Buffer.from(await dl.arrayBuffer());
  let filename = `simba.${skillId}`;
  try { const meta = await client.beta.files.retrieveMetadata(fileId); if (meta?.filename) filename = meta.filename; } catch { /* keep default */ }
  return { filename, data: buffer.toString("base64") };
}

app.post("/api/document", async (req, res) => {
  if (!preflight(req, res)) return;
  const skillId = DOC_SKILL[String(req.body?.kind || "pdf").toLowerCase()] || "pdf";
  const instructions = String(req.body?.instructions || "").slice(0, 8000);
  if (!instructions) return res.status(400).json({ error: "Missing 'instructions'." });
  try {
    const { filename, data } = await generateDocument(skillId, instructions);
    res.json({ filename, data, media_type: DOC_MEDIA[skillId] });
  } catch (err) {
    console.error("[Simba] /api/document error:", err?.message || err);
    res.status(err.status || 502).json({ error: "Kunde inte skapa dokumentet." });
  }
});

// Run Python (pandas/numpy) over the selected data for analysis Excel can't do.
app.post("/api/analyze", async (req, res) => {
  if (!preflight(req, res)) return;
  const data = String(req.body?.data || "").slice(0, 200_000);
  const question = String(req.body?.question || "").slice(0, 2000);
  if (!data) return res.status(400).json({ error: "Missing 'data'." });
  try {
    const text = await runWithServerTools({
      system: "You are Simba, a data analyst. Use Python (pandas/numpy) to analyze the user's spreadsheet data and answer concretely. ALWAYS answer in Swedish (svenska). Give the key numbers and a short, plain-language conclusion; do not paste raw code.",
      content: `Här är data från användarens kalkylark (CSV):\n\n${data}\n\nFråga: ${question || "Sammanfatta och lyft fram det viktigaste, inklusive avvikelser och trender."}`,
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
    });
    res.json({ text });
  } catch (err) {
    console.error("[Simba] /api/analyze error:", err?.message || err);
    res.status(502).json({ error: "Kunde inte analysera data." });
  }
});

// General-purpose code execution: run Python for any task (not just spreadsheets).
app.post("/api/code", async (req, res) => {
  if (!preflight(req, res)) return;
  const task = String(req.body?.task || "").slice(0, 8000);
  const data = String(req.body?.data || "").slice(0, 200_000);
  if (!task) return res.status(400).json({ error: "Missing 'task'." });
  try {
    const text = await runWithServerTools({
      system: "You are Simba, a precise problem-solver. Use Python to compute the answer accurately. ALWAYS reply in Swedish (svenska). Give the result and a short, plain-language explanation; do not paste raw code unless the user asked to see it.",
      content: data ? `Uppgift: ${task}\n\nIndata:\n${data}` : `Uppgift: ${task}`,
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
    });
    res.json({ text });
  } catch (err) {
    console.error("[Simba] /api/code error:", err?.message || err);
    res.status(502).json({ error: "Kunde inte köra koden." });
  }
});

// Look something up on the web (with the model's server-side search/fetch).
app.post("/api/research", async (req, res) => {
  if (!preflight(req, res)) return;
  const query = String(req.body?.query || "").slice(0, 2000);
  if (!query) return res.status(400).json({ error: "Missing 'query'." });
  try {
    const text = await runWithServerTools({
      system: "You are Simba, a research assistant. Use web search/fetch to find current, accurate facts. ALWAYS answer in Swedish (svenska). Be concise and concrete — return the specific answer the user can put in a spreadsheet, and name your source(s). If unsure, say so.",
      content: query,
      tools: [
        { type: "web_search_20260209", name: "web_search" },
        { type: "web_fetch_20260209", name: "web_fetch" },
      ],
    });
    res.json({ text });
  } catch (err) {
    console.error("[Simba] /api/research error:", err?.message || err);
    res.status(502).json({ error: "Kunde inte söka på webben." });
  }
});

// ---- OneDrive / SharePoint files via Microsoft Graph (OBO) ---------------
// Requires SSO + a client secret + the Files.Read delegated permission.
const FILE_OPEN_MAX = 8 * 1024 * 1024;

app.get("/api/files", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!graphConfigured) return res.status(501).json({ error: "Molnfiler är inte aktiverade på servern.", graphConfigured: false });
  try {
    const gt = await oboGraphToken(bearer(req));
    res.json({ files: await searchFiles(gt, req.query.q) });
  } catch (err) {
    console.error("[Simba] /api/files error:", err?.message || err);
    res.status(err.status || 502).json({ error: "Kunde inte hämta dina filer." });
  }
});

app.post("/api/files/open", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!graphConfigured) return res.status(501).json({ error: "Molnfiler är inte aktiverade på servern." });
  const id = String(req.body?.id || "");
  if (!id) return res.status(400).json({ error: "Missing 'id'." });
  try {
    const gt = await oboGraphToken(bearer(req));
    const { name, buffer } = await downloadFile(gt, id, FILE_OPEN_MAX);
    const lower = name.toLowerCase();
    if (/\.(csv|tsv|txt|md|json|tab|xml|log)$/.test(lower)) {
      res.json({ kind: "text", name, text: buffer.toString("utf8").slice(0, 200_000) });
    } else if (/\.(png|jpe?g|gif|webp)$/.test(lower)) {
      const media_type = /\.jpe?g$/.test(lower) ? "image/jpeg" : lower.endsWith(".gif") ? "image/gif" : lower.endsWith(".webp") ? "image/webp" : "image/png";
      res.json({ kind: "image", name, media_type, data: buffer.toString("base64") });
    } else if (/\.pdf$/.test(lower)) {
      res.json({ kind: "pdf", name, data: buffer.toString("base64") });
    } else {
      res.status(415).json({ error: `Filtypen stöds inte ännu (${name}). Stödjer text/CSV, bilder och PDF.` });
    }
  } catch (err) {
    console.error("[Simba] /api/files/open error:", err?.message || err);
    res.status(err.status || 502).json({ error: "Kunde inte öppna filen." });
  }
});

// ---- Scheduled jobs (server-side agent that edits OneDrive files via Graph) --
// A job runs unattended on a schedule; see scheduler.js. Creating one needs SSO
// (to key it to the user) and captures the file's driveId via OBO so an
// app-only run can address it later.
app.get("/api/jobs", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ jobs: await listJobs(user.key), schedulerEnabled }); }
  catch (err) { console.error("[Simba] jobs list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta scheman." }); }
});

app.post("/api/jobs", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const { name, prompt, schedule, itemId, notify } = req.body || {};
  if (!itemId) return res.status(400).json({ error: "Välj en målfil för schemat." });
  if (!graphConfigured) return res.status(501).json({ error: "Molnfiler (Graph) krävs för scheman." });
  try {
    // Resolve the file's drive so an unattended (app-only) run can find it later.
    const gt = await oboGraphToken(bearer(req));
    const info = await itemDriveInfo(gt, String(itemId));
    if (!info.driveId) return res.status(400).json({ error: "Kunde inte fastställa filens enhet (driveId)." });
    const job = await createJob(user.key, { name, prompt, schedule, target: { itemId: info.id, driveId: info.driveId, fileName: info.name, notify: notify !== false, email: user.email } });
    res.json({ job });
  } catch (err) {
    console.error("[Simba] job create failed:", err?.message || err);
    res.status(err.status || 502).json({ error: err.message || "Kunde inte skapa schemat." });
  }
});

app.put("/api/jobs/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const job = await updateJob(user.key, req.params.id, req.body || {});
    if (!job) return res.status(404).json({ error: "Hittades inte." });
    res.json({ job });
  } catch (err) { console.error("[Simba] job update failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte uppdatera schemat." }); }
});

app.delete("/api/jobs/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { await deleteJob(user.key, req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("[Simba] job delete failed:", err?.message || err); res.status(502).json({ error: "Kunde inte ta bort schemat." }); }
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
  startScheduler(client, MODEL);
  console.log(`[Simba] scheduled agent: ${schedulerEnabled ? "on" : "off (set SIMBA_SCHEDULER=1 + app-only Graph)"}`);
});

// Keep the process alive on unexpected errors; shut down cleanly on SIGTERM.
process.on("unhandledRejection", (reason) => console.error("[Simba] unhandledRejection:", reason));
process.on("uncaughtException", (err) => console.error("[Simba] uncaughtException:", err));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
