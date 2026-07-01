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
import { recordUsage, getUsage, getStats } from "./usage.js";
import { getMemory, setMemory, usingPostgres, listConversations, getConversation, saveConversation, deleteConversation, renameConversation, listWorkspace, saveWorkspace, deleteWorkspace, workspaceContext } from "./store.js";
import { randomUUID } from "node:crypto";
import { graphConfigured, oboGraphToken, searchFiles, downloadFile, itemDriveInfo, listMail, getMail, sendMail, listAttachments, getAttachment, MAIL_SCOPE } from "./graph.js";
import { listJobs, createJob, updateJob, deleteJob, getJobOwned } from "./jobs.js";
import { startScheduler, schedulerEnabled, runOrgAgent } from "./scheduler.js";
import { appOnlyGraphToken, sendMailAsUser } from "./graph.js";
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent, listRuns, listApprovals, getApproval, decideApproval, logRun } from "./orgagents.js";
import { chooseModel, lastUserText } from "./router.js";
import { listVault, getEntry, createEntry, updateEntry, deleteEntry, searchVault, retrieveForContext, retrieveWithSources, getFile as getVaultFile, digest as vaultDigest, vectorEnabled } from "./vault.js";
import { listConnectors, createConnector, updateConnector, deleteConnector, queryConnector, testConnector, writeConnector } from "./connectors.js";
import { listSources, createSource, deleteSource, syncSourceById } from "./ingest.js";
import { teamsConfigured, verifyBotToken, sendActivity, cleanTeamsText, conversationHistory, rememberTurn, TEAMS_SYSTEM } from "./teamsbot.js";
import { listTemplates, createTemplate, deleteTemplate } from "./templates.js";
import { listWatchers, createWatcher, deleteWatcher, checkWatcher } from "./watchers.js";
import { listMissions, getMission, createMission, cancelMission, runMission } from "./missions.js";

// Optional: restrict who can WRITE the shared company vault (comma-separated
// Microsoft object-ids). Empty = any signed-in org member can contribute.
const VAULT_ADMINS = (process.env.SIMBA_VAULT_ADMINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const canWriteVault = (user) => !VAULT_ADMINS.length || VAULT_ADMINS.includes(String(user.key).split(":")[1]);
const orgOf = (user) => String(user.key).split(":")[0]; // tenant id = org scope

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, "../dist");

const PORT = process.env.PORT || 3001;
const MODEL = process.env.SIMBA_MODEL || "claude-opus-4-8";
// Cheaper/faster model for simple turns. An automatic router (chooseModel) sends
// plain conversational questions here and keeps Opus for sheet work, tool use,
// attachments, and longer/complex prompts. Toggle with SIMBA_ROUTER=0.
const MODEL_SIMPLE = process.env.SIMBA_MODEL_SIMPLE || "claude-haiku-4-5-20251001";
const ROUTER_ON = process.env.SIMBA_ROUTER !== "0";

// Optional remote MCP connectors (experimental, admin-configured, off by default).
// SIMBA_MCP_SERVERS = JSON array like [{"name":"notion","url":"https://...","token":"..."}].
// When set, these are passed to the model so it can use those servers' tools.
let MCP_SERVERS = [];
try {
  if (process.env.SIMBA_MCP_SERVERS) {
    MCP_SERVERS = JSON.parse(process.env.SIMBA_MCP_SERVERS)
      .map((s) => ({ type: "url", url: String(s.url || ""), name: String(s.name || "mcp"), ...(s.token ? { authorization_token: String(s.token) } : {}) }))
      .filter((s) => s.url);
    if (MCP_SERVERS.length) console.log(`[Simba] MCP connectors: ${MCP_SERVERS.map((s) => s.name).join(", ")}`);
  }
} catch (e) { console.error("[Simba] SIMBA_MCP_SERVERS parse failed:", e.message); }

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

Outlook mail: you can work with the signed-in user's email via list_emails (list or
search the inbox), read_email (open one in full), and send_email (send or reply on
their behalf). Use them to triage, summarize and analyze mail, find context, and draft
replies. ALWAYS draft the message and let the user review it — send_email shows a
confirmation preview before anything is sent; never invent recipients. Summarize and
quote accurately; don't fabricate email content you haven't read.

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

Company knowledge vault (your shared, long-term mind):
- Besides per-user memory, there is a SHARED organization-wide knowledge vault — the
  company's structured facts (policies, products, customers, definitions, conventions),
  the same for every user and every session. The most relevant entries are injected each
  turn under "[Företagets kunskapsbank …]" — treat those as authoritative company facts
  and ground your answers in them.
- Use search_vault to look something company-specific up in depth. When the user shares a
  durable, company-wide fact worth keeping for everyone, offer to save it with
  save_to_vault (confirm first; choose a clear topic/branch). Use the per-user remember
  tool for personal preferences, and the vault for shared company knowledge. Never store secrets.

Business & finance systems (live company data):
- Your organization may connect finance/business systems (e.g. Fortnox, Visma, a
  project tool) as data sources. Use list_data_sources to see what's available and
  query_data_source to fetch live data, then summarize it clearly — how the companies
  are doing, invoicing status, overdue invoices, revenue, project progress, etc.
- Read the data, then present it: key figures first, a short plain-language assessment,
  and offer to write it into the sheet (write_range/create_chart) or draft an email.
  This data is sensitive — only share it with the signed-in user; never invent numbers
  you didn't fetch. If no sources are configured, tell the user an admin can add one.

Working across surfaces (Excel ↔ Outlook ↔ web/desktop):
- You are the SAME Simba on every surface for a signed-in user. Conversations, memory and
  the company vault already follow them everywhere.
- There is also a per-user SHARED WORKSPACE that syncs working context across surfaces.
  Use save_to_workspace to carry something between apps — e.g. in Excel capture a table or
  key figures, then in Outlook draft a mail using them. Use get_workspace to fetch what was
  saved elsewhere (the items are also auto-provided each turn). Live spreadsheet cells are
  only readable inside Excel, so to use sheet data in Outlook, save it to the workspace from
  Excel first (or open the workbook from OneDrive with list_files/open_file).

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

  { name: "list_emails", description: "List or search the signed-in user's Outlook mail (newest first). Use to triage the inbox, find messages, or gather context before replying. Returns id + subject + sender + preview for each; pass an id to read_email.",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "Optional text to search for (sender, subject, body)." },
      folder: { type: "string", description: "Optional folder, e.g. inbox, sentitems, drafts." },
      limit: { type: "integer", description: "How many to return (default 15, max 50)." },
    } } },

  { name: "read_email", description: "Read one Outlook message in full (sender, recipients, date, body) by id from list_emails. Use to analyze, summarize, or draft a reply.",
    input_schema: { type: "object", properties: {
      id: { type: "string", description: "The message id from list_emails." },
    }, required: ["id"] } },

  { name: "read_current_email", description: "Read the email currently open in Outlook (subject, sender, recipients, body) directly from the mailbox — no id needed. Use when the user refers to 'this email' / 'det här mejlet' while in Outlook.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "send_email", description: "Send an email as the signed-in user (or reply to a message by passing reply_to_id). The user is shown a confirmation with the draft before anything is sent. Use to send or reply on the user's behalf after drafting the content.",
    input_schema: { type: "object", properties: {
      to: { type: "string", description: "Recipient address(es), comma-separated. Omit when reply_to_id is set to reply to the sender." },
      cc: { type: "string", description: "Optional cc address(es), comma-separated." },
      subject: { type: "string", description: "Subject (ignored for replies)." },
      body: { type: "string", description: "The message text." },
      reply_to_id: { type: "string", description: "Optional message id to reply to in-thread." },
    }, required: ["body"] } },

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

  { name: "update_plan", description: "While executing a plan you proposed with propose_plan, check off finished steps (1-based indexes) and optionally mark the step you're on. Keeps the user informed during long builds. Call it as you complete each step or two.",
    input_schema: { type: "object", properties: {
      done_steps: { type: "array", description: "1-based indexes of steps now completed.", items: { type: "integer" } },
      current_step: { type: "integer", description: "1-based index of the step you're working on now." },
      note: { type: "string", description: "Optional one-line progress note shown under the plan." },
    } } },

  { name: "show_chart", description: "Render a chart directly in the chat (bar, line or pie) to visualize numbers you've computed — sums per month, category splits, trends. Use REAL values you calculated (from the sheet, run_code or analyze_data); never invent data. Prefer a chart over a wall of numbers when comparing more than ~4 values.",
    input_schema: { type: "object", properties: {
      title: { type: "string", description: "Short chart title." },
      type: { type: "string", enum: ["bar", "line", "pie"], description: "Chart form: bar = compare categories, line = trend over time, pie = share of a whole (max ~6 slices)." },
      labels: { type: "array", description: "X-axis / slice labels.", items: { type: "string" } },
      series: { type: "array", description: "One or more data series aligned with labels (pie uses the first).", items: { type: "object", properties: {
        name: { type: "string" }, values: { type: "array", items: { type: "number" } },
      }, required: ["values"] } },
    }, required: ["type", "labels", "series"] } },

  { name: "delegate_task", description: "Hand a single, self-contained sub-task to a focused subagent that works on its own (with the same tools) and returns a short result. Use to break a big job into independent parts (e.g. 'build the summary sheet', 'create the regional charts') so each runs with clean focus. Don't delegate trivial one-step actions; do them yourself.",
    input_schema: { type: "object", properties: {
      task: { type: "string", description: "The complete, self-contained instruction for the subagent." },
      context: { type: "string", description: "Optional facts the subagent needs (addresses, names, conventions) since it does not see this conversation." },
    }, required: ["task"] } },

  { name: "search_vault", description: "Search the company knowledge vault — the shared, organization-wide knowledge base (Simba's long-term 'mind'). Use to look up authoritative company facts, policies, definitions, people, products, conventions. The most relevant entries are also auto-injected each turn, but call this to dig deeper on a specific topic.",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "What to look up in the company knowledge base." },
    }, required: ["query"] } },

  { name: "save_to_vault", description: "Add a durable fact to the SHARED company knowledge vault so every user and future session knows it. Use for stable, company-wide knowledge (policies, definitions, product facts, conventions) — confirm with the user first. Not for personal preferences (use remember) or secrets.",
    input_schema: { type: "object", properties: {
      topic: { type: "string", description: "A short category/branch, e.g. 'Produkter', 'Policys', 'Kunder'." },
      title: { type: "string", description: "A short, specific title for the entry." },
      content: { type: "string", description: "The fact(s), written so they're useful later." },
      tags: { type: "array", description: "Optional keywords.", items: { type: "string" } },
    }, required: ["title", "content"] } },

  { name: "save_to_workspace", description: "Save a piece of working context to the user's SHARED workspace, which syncs across their surfaces (Excel, Outlook, web, desktop). Use to carry information between apps — e.g. capture a table or figures in Excel so you can use them when drafting a mail in Outlook. Personal to the user (not the whole org).",
    input_schema: { type: "object", properties: {
      label: { type: "string", description: "A short name for this context item." },
      content: { type: "string", description: "The information to carry over (text, a small table as CSV, key figures)." },
      source: { type: "string", description: "Optional origin, e.g. 'Excel: Q3-budget'." },
    }, required: ["content"] } },

  { name: "get_workspace", description: "List the user's shared workspace items (working context synced across Excel/Outlook/web). Use to fetch something they saved on another surface — e.g. read in Outlook a table they captured in Excel. The items are also auto-provided each turn, but call this to see them all.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "list_data_sources", description: "List the connected business/finance systems (e.g. Fortnox, Visma, a project tool) and the read endpoints available on each — their keys, labels and what they return. Call this first to discover what live company data you can fetch (invoicing, revenue, projects, customers).",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },

  { name: "query_data_source", description: "Fetch live data from a connected finance/business system via a whitelisted endpoint (from list_data_sources), then summarize/analyze it for the user — how the companies are doing, invoicing status, project progress, etc. Read-only.",
    input_schema: { type: "object", properties: {
      source: { type: "string", description: "Data source name or id (from list_data_sources)." },
      endpoint: { type: "string", description: "Endpoint key or label to call." },
      params: { type: "object", description: "Optional query parameters (e.g. {\"from\":\"2026-01-01\",\"status\":\"unpaid\"}).", additionalProperties: true },
    }, required: ["source", "endpoint"] } },

  { name: "analyze_vault", description: "Analyze the whole company knowledge vault: coverage gaps, contradictions/duplicates/outdated entries, structure quality, why it looks the way it does, and concrete improvements. Use when the user asks to review/audit/improve the company knowledge base.",
    input_schema: { type: "object", properties: {
      focus: { type: "string", description: "Optional area to focus the review on." },
    } } },

  { name: "open_vault_file", description: "Open a document/PDF/image attached to a knowledge-vault entry so you can read or see it. Pass the entry id (from search_vault).",
    input_schema: { type: "object", properties: {
      id: { type: "string", description: "The vault entry id whose attachment to open." },
    }, required: ["id"] } },

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
    vectorSearch: vectorEnabled,
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

// ---- Profile: usage + estimated spend for the signed-in user --------------
app.get("/api/usage", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const usage = await getUsage(user.key);
    res.json({
      profile: { name: user.name || "", email: user.email || "", org: orgOf(user) || "" },
      usage,
      limits: { dailyTurns: USER_DAILY || 0 },
      model: MODEL,
    });
  } catch (err) {
    console.error("[Simba] usage read failed:", err?.message || err);
    res.status(502).json({ error: "Kunde inte hämta användning." });
  }
});

// ---- Home dashboard: rich activity stats for the welcome screen -----------
app.get("/api/stats", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const [stats, convs] = await Promise.all([
      getStats(user.key),
      listConversations(user.key).catch(() => []),
    ]);
    res.json({
      name: user.name || user.email || "",
      sessions: Array.isArray(convs) ? convs.length : 0,
      ...stats,
    });
  } catch (err) {
    console.error("[Simba] stats failed:", err?.message || err);
    res.status(502).json({ error: "Kunde inte hämta statistik." });
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
  else if (surface === "outlook") blocks.push({ type: "text", text:
    "[Läge] Du körs inuti Microsoft Outlook. Du kan läsa det MEJL SOM ÄR ÖPPET just nu direkt " +
    "med read_current_email (be om det när användaren säger 'det här mejlet'), samt arbeta med " +
    "hela brevlådan (list_emails/read_email/send_email), molnfiler, kunskapsbanken och det delade " +
    "arbetsutrymmet. Live-redigering av kalkylark sker i Excel-tillägget." });
  else blocks.push({ type: "text", text:
    "[Läge] Du körs inuti Microsoft Excel. Du har full tillgång till kalkylarksverktygen — " +
    "läs och redigera arket direkt — utöver dina allmänna förmågor (webb, kod, dokument, minne)." });
  // Cache the whole system prefix (prompt + memory + surface) as a unit — it only
  // changes when the user's memory changes, so nearly every turn reads it from cache.
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  return blocks;
}

/* Per-turn retrieval (vault + workspace) used to live in the system prompt, but
 * system renders BEFORE the messages — so retrieval text that varies with every
 * query invalidated the prompt cache for the ENTIRE conversation each turn (full
 * re-processing cost + latency). Instead we append it to the LAST user-text
 * message: the prefix stays byte-stable, and within a tool loop the injection is
 * deterministic (same query → same retrieval), so cache hits survive the loop. */
function injectContext(messages, vault, workspace) {
  const v = String(vault || "").slice(0, 6000);
  const ws = String(workspace || "").slice(0, 3500);
  if (!v && !ws) return messages;
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (Array.isArray(m.content) && m.content.some((b) => b && b.type === "tool_result")) continue;
    idx = i; break;
  }
  if (idx < 0) return messages;
  const parts = [];
  if (v) parts.push(`[Företagets kunskapsbank — delad mellan alla i organisationen. Behandla som auktoritativa fakta om företaget; grunda dina svar i detta och säg till om något saknas.]\n${v}`);
  if (ws) parts.push(`[Ditt delade arbetsutrymme — synkat mellan Excel, Outlook, webb och dator. Sådant användaren sparat och kan vilja använda här.]\n${ws}`);
  const out = messages.slice();
  const m = { ...out[idx] };
  let content = m.content;
  if (typeof content === "string") content = [{ type: "text", text: content }];
  else if (Array.isArray(content)) content = content.map((b) => ({ ...b }));
  else return messages;
  content.push({ type: "text", text: `<automatisk_kontext>\n${parts.join("\n\n")}\n</automatisk_kontext>` });
  m.content = content;
  out[idx] = m;
  return out;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (i) => Math.min(8000, 500 * 2 ** i) + Math.floor(Math.random() * 250);
function isRetryable(e) {
  const s = e?.status;
  return s === 429 || s === 500 || s === 502 || s === 503 || s === 529 || e?.name === "APIConnectionError" || e?.name === "APIConnectionTimeoutError";
}
// Retry a one-shot (non-streaming) API call with exponential backoff.
async function withRetry(fn, label = "") {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!isRetryable(e) || i >= 2) throw e;
      await sleep(backoffMs(i));
      console.warn(`[Simba] retry ${label} ${i + 1} after ${e?.status || e?.message}`);
    }
  }
}

// Map the client's model preference to a concrete model. "pluto" = the strong
// Opus model, "simba" = the fast Haiku model; anything else routes automatically.
function pickModel(pref, messages, speed) {
  if (pref === "pluto" || pref === "strong") return MODEL;
  if (pref === "simba" || pref === "simple") return MODEL_SIMPLE;
  return chooseModel(messages, speed, { strong: MODEL, simple: MODEL_SIMPLE, on: ROUTER_ON });
}

async function runModel(messages, speed, memory, surface, onText, vault, workspace, modelPref) {
  const cfg = SPEED_MAP[speed] || SPEED_MAP[DEFAULT_SPEED] || SPEED_MAP.balanced;
  const model = pickModel(modelPref, messages, speed);
  const base = {
    model,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: cfg.effort },
    system: buildSystem(memory, surface),
    tools: TOOLS,
    messages: withConversationCache(injectContext(messages, vault, workspace)),
  };
  // Base betas from optional MCP connectors; fast mode adds its own.
  const baseBetas = [];
  if (MCP_SERVERS.length) { base.mcp_servers = MCP_SERVERS; baseBetas.push("mcp-client-2025-04-04"); }

  let emitted = false;
  const run = async (params, extraBetas = []) => {
    const betas = [...baseBetas, ...extraBetas];
    const p = betas.length ? { ...params, betas } : params;
    const s = (betas.length ? client.beta.messages : client.messages).stream(p);
    s.on("text", (t) => { emitted = true; if (onText) onText(t); });
    return await s.finalMessage();
  };
  // Fast mode applies to the strong (Opus) model; Haiku is already fast.
  if (cfg.fast && model === MODEL) {
    try {
      return await run({ ...base, speed: "fast" }, ["fast-mode-2026-02-01"]);
    } catch (e) {
      if (emitted) throw e; // already streamed output — don't restart
      console.warn("[Simba] fast mode unavailable, using standard speed:", e?.status || e?.message);
    }
  }
  // Retry transient API errors with backoff — but only while nothing has streamed
  // yet (we can't safely restart a half-emitted reply).
  for (let i = 0; ; i++) {
    try { return await run(base); }
    catch (e) {
      if (emitted || !isRetryable(e) || i >= 2) throw e;
      await sleep(backoffMs(i));
      console.warn(`[Simba] chat retry ${i + 1} after ${e?.status || e?.message}`);
    }
  }
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
// The quota "day" follows the org's local timezone (not UTC), so the cap resets
// at local midnight instead of 01/02:00 for Swedish users.
const QUOTA_TZ_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.SIMBA_TZ || "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" });
function quotaExceeded(userKey) {
  if (!USER_DAILY || !userKey) return false;
  const day = QUOTA_TZ_FMT.format(new Date());
  const q = userQuota.get(userKey);
  if (!q || q.day !== day) {
    userQuota.set(userKey, { day, n: 1 });
    if (userQuota.size > 20000) for (const [k, v] of userQuota) { if (v.day !== day) userQuota.delete(k); } // drop stale days
    return false;
  }
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

  // Identify the user (when SSO is on + a token is sent) for the daily cap and to
  // pull the org's shared knowledge vault into context.
  let user = null;
  if (ssoConfigured && bearer(req)) {
    try { user = await verifyToken(bearer(req)); } catch { /* fall back to IP limits, no vault */ }
  }
  if (REQUIRE_AUTH && !user)
    return res.status(401).json({ error: "Inloggning krävs för att använda Simba." });
  if (user && USER_DAILY && quotaExceeded(user.key)) {
    res.set("Retry-After", "3600");
    return res.status(429).json({ error: "Du har nått din dagliga gräns för Simba. Försök igen imorgon." });
  }
  let vaultText = "", workspaceText = "", vaultSources = [];
  if (user) {
    // Run both context lookups concurrently — they're independent stores.
    const [vaultHit, ws] = await Promise.all([
      retrieveWithSources(orgOf(user), lastUserText(req.body.messages))
        .catch((e) => { console.error("[Simba] vault retrieve failed:", e?.message || e); return { text: "", sources: [] }; }),
      workspaceContext(user.key)
        .catch((e) => { console.error("[Simba] workspace retrieve failed:", e?.message || e); return ""; }),
    ]);
    vaultText = vaultHit.text; vaultSources = vaultHit.sources; workspaceText = ws;
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
    const final = await runModel(req.body.messages, req.body.speed, req.body.memory, req.body.surface, (t) => send("delta", { text: t }), vaultText, workspaceText, req.body.model);
    send("final", {
      content: final.content,
      stop_reason: final.stop_reason,
      usage: final.usage,
      model: final.model,
      sources: vaultSources, // vault entries the context was grounded in (citations)
    });
    // Record token usage + estimated spend for the signed-in user's profile view.
    if (user && final.usage) recordUsage(user.key, final.model, final.usage).catch(() => {});
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
    const resp = await withRetry(() => client.messages.create({ model: MODEL, max_tokens: 8000, system, tools, messages }), "server-tools");
    if (resp.stop_reason === "pause_turn") { // server tool still working — resume
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }
  return "Analysen tog för många steg. Försök avgränsa frågan.";
}

// Optional hard auth on the model endpoints (denial-of-wallet guard): with
// SIMBA_REQUIRE_AUTH=1 (and SSO configured), anonymous requests can no longer
// drive Claude calls. Off by default so open/no-SSO deployments keep working.
const REQUIRE_AUTH = process.env.SIMBA_REQUIRE_AUTH === "1" && ssoConfigured;
async function enforceAuth(req, res) {
  if (!REQUIRE_AUTH) return true;
  try { await verifyToken(bearer(req)); return true; }
  catch { res.status(401).json({ error: "Inloggning krävs för att använda Simba." }); return false; }
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
    last = await withRetry(() => client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["code-execution-2025-08-25", "skills-2025-10-02"],
      container: { skills: [{ type: "anthropic", skill_id: skillId, version: "latest" }] },
      tools: [{ type: "code_execution_20260521", name: "code_execution" }],
      messages,
    }), "document");
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
  if (!(await enforceAuth(req, res))) return;
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
  if (!(await enforceAuth(req, res))) return;
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
  if (!(await enforceAuth(req, res))) return;
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
  if (!(await enforceAuth(req, res))) return;
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

// ---- Deep research: a multi-round, cited research run ---------------------
// Unlike /api/research (one pass), this streams a full research session: the
// model plans, runs several web_search/web_fetch rounds, then synthesizes a
// structured Swedish report with source links. SSE like /api/chat.
const DEEPRESEARCH_SYSTEM =
  "Du är Simbas djupresearch-läge. Arbeta som en researcher: bryt ned frågan, sök brett (flera sökningar med olika vinklar), " +
  "hämta och läs de viktigaste källorna med web_fetch, korsvalidera påståenden mellan oberoende källor, och skriv sedan en " +
  "strukturerad svensk rapport i markdown: kort sammanfattning överst (3–5 punkter), sedan tematiska avsnitt, sedan en " +
  "källförteckning med länkar. Ange källa (länk) direkt vid viktiga sifferpåståenden. Var ärlig om osäkerhet och motstridiga " +
  "uppgifter. Hitta ALDRIG på källor.";

app.post("/api/deepresearch", async (req, res) => {
  if (!preflight(req, res)) return;
  if (!(await enforceAuth(req, res))) return;
  const question = String(req.body?.question || "").trim().slice(0, 4000);
  if (!question) return res.status(400).json({ error: "Ange en forskningsfråga." });
  let user = null;
  if (ssoConfigured && bearer(req)) { try { user = await verifyToken(bearer(req)); } catch { /* anon ok unless REQUIRE_AUTH */ } }

  res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  inflight++;
  try {
    const messages = [{ role: "user", content: `Forskningsfråga: ${question}` }];
    let final = null;
    for (let round = 0; round < 12; round++) {
      const s = client.messages.stream({
        model: MODEL, max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        system: DEEPRESEARCH_SYSTEM,
        tools: [
          { type: "web_search_20260209", name: "web_search", max_uses: 12 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10 },
        ],
        messages,
      });
      s.on("text", (t) => send("delta", { text: t }));
      final = await s.finalMessage();
      if (user && final.usage) recordUsage(user.key, final.model, final.usage).catch(() => {});
      if (final.stop_reason !== "pause_turn") break; // server tools done
      messages.push({ role: "assistant", content: final.content }); // resume
    }
    send("final", { content: final?.content || [], stop_reason: final?.stop_reason, model: final?.model });
  } catch (err) {
    console.error("[Simba] /api/deepresearch error:", err?.message || err);
    send("error", { error: "Djupresearchen kunde inte slutföras. Försök igen." });
  } finally {
    inflight--;
    res.end();
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

// ---- Centralized org agents (shared, logged, approvable) -----------------
// Everyone in the org can see the agents and their activity; managing them and
// approving their actions is admin-gated (SIMBA_VAULT_ADMINS).
app.get("/api/agents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ agents: await listAgents(orgOf(user)), canManage: canWriteVault(user) }); }
  catch (err) { console.error("[Simba] agents list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta agenter." }); }
});

app.post("/api/agents", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan skapa agenter." });
  try { res.json({ agent: await createAgent(orgOf(user), { ...req.body, createdBy: user.email || user.name }) }); }
  catch (err) { console.error("[Simba] agent create failed:", err?.message || err); res.status(502).json({ error: "Kunde inte skapa agenten." }); }
});

app.put("/api/agents/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan ändra agenter." });
  try { const a = await updateAgent(orgOf(user), req.params.id, req.body || {}); if (!a) return res.status(404).json({ error: "Hittades inte." }); res.json({ agent: a }); }
  catch (err) { console.error("[Simba] agent update failed:", err?.message || err); res.status(502).json({ error: "Kunde inte uppdatera." }); }
});

app.delete("/api/agents/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan ta bort agenter." });
  try { await deleteAgent(orgOf(user), req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("[Simba] agent delete failed:", err?.message || err); res.status(502).json({ error: "Kunde inte ta bort." }); }
});

app.get("/api/agents/:id/runs", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ runs: await listRuns(orgOf(user), req.params.id) }); }
  catch (err) { console.error("[Simba] agent runs failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta aktivitet." }); }
});

// Run an agent now (admin) — handy for testing without waiting for the date.
app.post("/api/agents/:id/run", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan köra agenter." });
  try {
    const a = await getAgent(orgOf(user), req.params.id);
    if (!a) return res.status(404).json({ error: "Hittades inte." });
    const result = await runOrgAgent(client, MODEL, { ...a, org_key: orgOf(user) });
    res.json({ result });
  } catch (err) { console.error("[Simba] agent run failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Körningen misslyckades." }); }
});

app.get("/api/agents-approvals", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ approvals: await listApprovals(orgOf(user), "pending"), canDecide: canWriteVault(user) }); }
  catch (err) { console.error("[Simba] approvals list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta godkännanden." }); }
});

app.post("/api/agents-approvals/:id/decide", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan godkänna." });
  const approve = req.body?.approve === true;
  try {
    // Claim the approval atomically FIRST — if another admin already decided it,
    // this returns null and no side effect runs twice.
    const ap = await decideApproval(orgOf(user), req.params.id, approve ? "approved" : "rejected", user.email || user.name);
    if (!ap) return res.status(404).json({ error: "Hittades inte eller redan beslutad." });
    if (approve && ap.kind === "send_email") {
      const p = ap.payload || {};
      try {
        const token = await appOnlyGraphToken(orgOf(user));
        const html = `<pre style="white-space:pre-wrap;font-family:system-ui">${String(p.body || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</pre>`;
        await sendMailAsUser(token, p.mailbox, p.to, p.subject, html);
        await logRun(orgOf(user), ap.agent_id, { status: "sent", summary: `Godkänt av ${user.email || user.name} – skickade till ${p.to}` });
      } catch (e) {
        await reopenApproval(orgOf(user), ap.id).catch(() => {}); // let an admin retry
        throw e;
      }
    } else if (approve && ap.kind === "connector_write") {
      // Post the approved bodies into the linked data source (e.g. reported hours → NEXT).
      const p = ap.payload || {};
      let okN = 0, failN = 0; const errs = [];
      for (const body of (p.bodies || [])) {
        try { await writeConnector(orgOf(user), p.connectorId, p.endpointKey, body); okN++; }
        catch (e) { failN++; if (errs.length < 3) errs.push(e.message || String(e)); }
      }
      if (failN && !okN) {
        await reopenApproval(orgOf(user), ap.id).catch(() => {}); // nothing was written — retryable
        await logRun(orgOf(user), ap.agent_id, { status: "error", summary: `Skrivning misslyckades helt: ${errs.join("; ")}` });
        return res.status(502).json({ error: `Kunde inte skriva till datakällan: ${errs.join("; ")}` });
      }
      await logRun(orgOf(user), ap.agent_id, {
        status: failN ? "partial" : "posted",
        summary: `Godkänt av ${user.email || user.name} – ${okN} post(er) skrivna till ${p.connectorName || "datakällan"}${failN ? `, ${failN} misslyckades (${errs.join("; ")})` : ""}`,
      });
    } else if (!approve) {
      await logRun(orgOf(user), ap.agent_id, { status: "rejected", summary: `Avvisat av ${user.email || user.name}` });
    }
    res.json({ approval: await getApproval(orgOf(user), req.params.id) });
  } catch (err) { console.error("[Simba] approval decide failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte slutföra." }); }
});

// ---- Finance / business-system connectors (bridge to economy systems) ----
// Config (base URL + secret headers + whitelisted endpoints) is admin-gated;
// reading data is allowed in-org. Secrets stay server-side.
// ---- Microsoft Teams bot -------------------------------------------------
// Bot Framework messaging endpoint. Same brain as the other surfaces: the
// Teams user's aadObjectId+tenantId map to the identical "tid:oid" user key,
// so memory and the org vault ground the answers here too.
app.post("/api/teams/messages", async (req, res) => {
  if (!teamsConfigured) return res.status(501).json({ error: "Teams-boten är inte konfigurerad." });
  try { await verifyBotToken(req.headers.authorization); }
  catch { return res.status(401).json({ error: "Ogiltig bot-token." }); }
  const activity = req.body || {};
  res.status(200).end(); // ack immediately; the reply is posted asynchronously

  if (activity.type !== "message" || !activity.serviceUrl || !activity.conversation?.id) return;
  const text = cleanTeamsText(activity.text);
  if (!text) return;
  try {
    const tid = activity.conversation.tenantId || activity.channelData?.tenant?.id || "";
    const oid = activity.from?.aadObjectId || "";
    const userKey = tid && oid ? `${tid}:${oid}` : "";
    const convId = activity.conversation.id;

    const [memoryNotes, vaultHit] = await Promise.all([
      userKey ? getMemory(userKey).catch(() => []) : [],
      tid ? retrieveWithSources(tid, text).catch(() => ({ text: "", sources: [] })) : { text: "", sources: [] },
    ]);
    const system = [
      { type: "text", text: TEAMS_SYSTEM, cache_control: { type: "ephemeral" } },
      ...(memoryNotes.length ? [{ type: "text", text: `[Vad du minns om användaren]\n${memoryNotes.map((n) => `- ${n}`).join("\n")}` }] : []),
      ...(vaultHit.text ? [{ type: "text", text: `[Företagets kunskapsbank]\n${vaultHit.text}` }] : []),
    ];
    const history = conversationHistory(convId);
    const messages = [...history, { role: "user", content: text }];
    const model = pickModel(null, messages, "balanced"); // auto-route (Pluto/Simba)
    const resp = await withRetry(() => client.messages.create({ model, max_tokens: 2000, system, messages }), "teams");
    const answer = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || "Jag har inget bra svar just nu.";
    rememberTurn(convId, text, answer);
    if (userKey && resp.usage) recordUsage(userKey, resp.model, resp.usage).catch(() => {});
    await sendActivity(activity.serviceUrl, convId, { type: "message", text: answer, textFormat: "markdown" });
  } catch (e) {
    console.error("[Simba] teams reply failed:", e?.message || e);
    sendActivity(activity.serviceUrl, activity.conversation.id, { type: "message", text: "Något gick fel — försök igen om en stund." }).catch(() => {});
  }
});

// ---- Uppdrag (goal-driven long jobs with a definition of done) -------------
app.get("/api/missions", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ missions: await listMissions(user.key) }); }
  catch (err) { console.error("[Simba] missions list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta uppdrag." }); }
});
app.get("/api/missions/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const m = await getMission(user.key, req.params.id);
    if (!m) return res.status(404).json({ error: "Hittades inte." });
    res.json({ mission: m });
  } catch (err) { res.status(502).json({ error: "Kunde inte hämta uppdraget." }); }
});
app.post("/api/missions", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const m = await createMission(user.key, orgOf(user), { goal: req.body?.goal, rubric: req.body?.rubric, maxIter: req.body?.maxIter });
    // Fire-and-forget: the mission runs in the background; the client polls.
    runMission(client, MODEL, user.key, m.id).catch((e) => console.error("[Simba] mission run failed:", e?.message || e));
    res.json({ mission: m });
  } catch (err) { res.status(err.status || 502).json({ error: err.message || "Kunde inte starta uppdraget." }); }
});
app.post("/api/missions/:id/cancel", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { await cancelMission(user.key, req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(502).json({ error: "Kunde inte avbryta." }); }
});

// ---- Proactive watchers ("bevakningar") ------------------------------------
app.get("/api/watchers", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ watchers: await listWatchers(user.key) }); }
  catch (err) { console.error("[Simba] watchers list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta bevakningar." }); }
});
app.post("/api/watchers", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const config = { ...(req.body?.config || {}), email: req.body?.config?.email || user.email };
    res.json({ watcher: await createWatcher(user.key, orgOf(user), { name: req.body?.name, kind: req.body?.kind, config }) });
  } catch (err) { res.status(err.status || 502).json({ error: err.message || "Kunde inte skapa bevakningen." }); }
});
app.post("/api/watchers/:id/check", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const w = (await listWatchers(user.key)).find((x) => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: "Hittades inte." });
    const r = await checkWatcher(client, MODEL_SIMPLE, { ...w, user_key: user.key, org_key: orgOf(user) });
    res.json({ result: r });
  } catch (err) { res.status(err.status || 502).json({ error: err.message || "Kontrollen misslyckades." }); }
});
app.delete("/api/watchers/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { await deleteWatcher(user.key, req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(502).json({ error: "Kunde inte ta bort bevakningen." }); }
});

// ---- Org-shared prompt templates ------------------------------------------
app.get("/api/templates", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ templates: await listTemplates(orgOf(user)) }); }
  catch (err) { console.error("[Simba] templates list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta mallar." }); }
});
app.post("/api/templates", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ template: await createTemplate(orgOf(user), { name: req.body?.name, prompt: req.body?.prompt, createdBy: user.email || user.name }) }); }
  catch (err) { res.status(err.status || 502).json({ error: err.message || "Kunde inte spara mallen." }); }
});
app.delete("/api/templates/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { await deleteTemplate(orgOf(user), req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(502).json({ error: "Kunde inte ta bort mallen." }); }
});

// ---- Vault auto-ingest sources (SharePoint/OneDrive folder sync) ----------
// Admins connect folders; everyone benefits from the synced knowledge.
app.get("/api/ingest-sources", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ sources: await listSources(orgOf(user)), canManage: canWriteVault(user) }); }
  catch (err) { console.error("[Simba] ingest list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta källor." }); }
});
app.post("/api/ingest-sources", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan koppla källor." });
  if (!req.body?.url) return res.status(400).json({ error: "Ange en delningslänk till en mapp." });
  try { res.json({ source: await createSource(orgOf(user), { url: req.body.url, name: req.body.name, createdBy: user.email || user.name }) }); }
  catch (err) { console.error("[Simba] ingest create failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte koppla källan." }); }
});
app.post("/api/ingest-sources/:id/sync", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan synka." });
  try { res.json({ result: await syncSourceById(orgOf(user), req.params.id, client) }); }
  catch (err) { console.error("[Simba] ingest sync failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Synken misslyckades." }); }
});
app.delete("/api/ingest-sources/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan ta bort källor." });
  try { await deleteSource(orgOf(user), req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("[Simba] ingest delete failed:", err?.message || err); res.status(502).json({ error: "Kunde inte ta bort källan." }); }
});

app.get("/api/connectors", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ connectors: await listConnectors(orgOf(user)), canManage: canWriteVault(user) }); }
  catch (err) { console.error("[Simba] connectors list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta datakällor." }); }
});

app.post("/api/connectors", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan lägga till datakällor." });
  try { res.json({ connector: await createConnector(orgOf(user), req.body || {}) }); }
  catch (err) { console.error("[Simba] connector create failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte spara datakällan." }); }
});

app.put("/api/connectors/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan ändra datakällor." });
  try {
    const c = await updateConnector(orgOf(user), req.params.id, req.body || {});
    if (!c) return res.status(404).json({ error: "Hittades inte." });
    res.json({ connector: c });
  } catch (err) { console.error("[Simba] connector update failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte uppdatera." }); }
});

app.delete("/api/connectors/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan ta bort datakällor." });
  try { await deleteConnector(orgOf(user), req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("[Simba] connector delete failed:", err?.message || err); res.status(502).json({ error: "Kunde inte ta bort." }); }
});

app.post("/api/connectors/test", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Endast administratörer kan testa datakällor." });
  const { id, base_url, headers, path, params } = req.body || {};
  if (!base_url && !id) return res.status(400).json({ error: "Ange bas-URL." });
  if (!path) return res.status(400).json({ error: "Ange en sökväg att testa." });
  try { res.json(await testConnector(orgOf(user), { id, base_url, headers, path, params })); }
  catch (err) { console.error("[Simba] connector test failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Testet misslyckades." }); }
});

app.post("/api/connectors/query", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const { source, endpoint, params } = req.body || {};
  if (!source || !endpoint) return res.status(400).json({ error: "Ange datakälla och endpoint." });
  try { res.json(await queryConnector(orgOf(user), source, endpoint, params)); }
  catch (err) { console.error("[Simba] connector query failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte hämta data." }); }
});

// ---- Shared workspace (syncs the user's working context across surfaces) ---
app.get("/api/workspace", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { res.json({ items: await listWorkspace(user.key) }); }
  catch (err) { console.error("[Simba] workspace list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta arbetsutrymmet." }); }
});

app.post("/api/workspace", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const { id, label, content, source } = req.body || {};
  if (!String(content || "").trim()) return res.status(400).json({ error: "Innehåll saknas." });
  try { res.json({ item: await saveWorkspace(user.key, { id, label, content, source }) }); }
  catch (err) { console.error("[Simba] workspace save failed:", err?.message || err); res.status(502).json({ error: "Kunde inte spara." }); }
});

app.delete("/api/workspace/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try { await deleteWorkspace(user.key, req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("[Simba] workspace delete failed:", err?.message || err); res.status(502).json({ error: "Kunde inte ta bort." }); }
});

// ---- Outlook mail (delegated, on behalf of the signed-in user) -----------
app.get("/api/mail", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!graphConfigured) return res.status(501).json({ error: "E-post (Graph) är inte aktiverat på servern." });
  try {
    const gt = await oboGraphToken(bearer(req), MAIL_SCOPE);
    const messages = await listMail(gt, { search: req.query.q, folder: req.query.folder, top: Number(req.query.top) || 15 });
    res.json({ messages });
  } catch (err) {
    console.error("[Simba] /api/mail error:", err?.message || err);
    res.status(err.status || 502).json({ error: "Kunde inte hämta e-post." });
  }
});

app.get("/api/mail/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!graphConfigured) return res.status(501).json({ error: "E-post (Graph) är inte aktiverat." });
  try {
    const gt = await oboGraphToken(bearer(req), MAIL_SCOPE);
    res.json({ message: await getMail(gt, req.params.id) });
  } catch (err) {
    console.error("[Simba] /api/mail/:id error:", err?.message || err);
    res.status(err.status || 502).json({ error: "Kunde inte öppna meddelandet." });
  }
});

app.get("/api/mail/:id/attachments", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!graphConfigured) return res.status(501).json({ error: "E-post (Graph) är inte aktiverat." });
  try {
    const gt = await oboGraphToken(bearer(req), MAIL_SCOPE);
    res.json({ attachments: await listAttachments(gt, req.params.id) });
  } catch (err) { console.error("[Simba] mail attachments error:", err?.message || err); res.status(err.status || 502).json({ error: "Kunde inte hämta bilagor." }); }
});

app.get("/api/mail/:id/attachments/:aid", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!graphConfigured) return res.status(501).json({ error: "E-post (Graph) är inte aktiverat." });
  try {
    const gt = await oboGraphToken(bearer(req), MAIL_SCOPE);
    res.json(await getAttachment(gt, req.params.id, req.params.aid));
  } catch (err) { console.error("[Simba] mail attachment error:", err?.message || err); res.status(err.status || 502).json({ error: "Kunde inte ladda ner bilagan." }); }
});

app.post("/api/mail/send", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!graphConfigured) return res.status(501).json({ error: "E-post (Graph) är inte aktiverat." });
  const { to, cc, subject, body, replyToId } = req.body || {};
  if (!replyToId && !to) return res.status(400).json({ error: "Ange minst en mottagare." });
  try {
    const gt = await oboGraphToken(bearer(req), MAIL_SCOPE);
    await sendMail(gt, { to, cc, subject, body, replyToId });
    res.json({ sent: true });
  } catch (err) {
    console.error("[Simba] /api/mail/send error:", err?.message || err);
    res.status(err.status || 502).json({ error: err.message || "Kunde inte skicka mejlet." });
  }
});

// ---- Shared company knowledge vault (Simba's org-wide "mind") -------------
app.get("/api/vault", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const q = req.query.q;
    const entries = q ? await searchVault(orgOf(user), String(q), 50) : await listVault(orgOf(user));
    res.json({ entries, canWrite: canWriteVault(user) });
  } catch (err) { console.error("[Simba] vault list failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta kunskapsbanken." }); }
});

app.post("/api/vault", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Du har inte behörighet att ändra kunskapsbanken." });
  try {
    const { topic, title, content, tags, file } = req.body || {};
    const entry = await createEntry(orgOf(user), { topic, title, content, tags, file, author: user.email || user.name || "" });
    res.json({ entry });
  } catch (err) { console.error("[Simba] vault create failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte spara posten." }); }
});

// Single entry — used by the citation chips under grounded answers.
app.get("/api/vault/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const entry = await getEntry(orgOf(user), req.params.id);
    if (!entry) return res.status(404).json({ error: "Posten hittades inte." });
    res.json({ entry });
  } catch (err) { console.error("[Simba] vault get failed:", err?.message || err); res.status(502).json({ error: "Kunde inte hämta posten." }); }
});

// Read an entry's attached file (text/CSV → text, image → base64, pdf → base64).
app.get("/api/vault/:id/file", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const f = await getVaultFile(orgOf(user), req.params.id);
    if (!f) return res.status(404).json({ error: "Ingen bilaga." });
    const lower = String(f.name || "").toLowerCase();
    if (/\.(csv|tsv|txt|md|json|tab|xml|log)$/.test(lower) || /^text\//.test(f.type || "")) {
      res.json({ kind: "text", name: f.name, text: Buffer.from(f.data, "base64").toString("utf8").slice(0, 200_000) });
    } else if (/^image\/(png|jpe?g|gif|webp)$/.test(f.type || "") || /\.(png|jpe?g|gif|webp)$/.test(lower)) {
      res.json({ kind: "image", name: f.name, media_type: f.type || "image/png", data: f.data });
    } else if (/\.pdf$/.test(lower) || f.type === "application/pdf") {
      res.json({ kind: "pdf", name: f.name, data: f.data });
    } else {
      res.status(415).json({ error: "Filtypen stöds inte för läsning." });
    }
  } catch (err) { console.error("[Simba] vault file failed:", err?.message || err); res.status(502).json({ error: "Kunde inte läsa bilagan." }); }
});

// Analyze the whole vault: gaps, inconsistencies, why-it-is, what to improve.
app.post("/api/vault/analyze", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!apiKey) return res.status(503).json({ error: "Server saknar ANTHROPIC_API_KEY." });
  try {
    const dg = await vaultDigest(orgOf(user));
    if (!dg.count) return res.json({ text: "Kunskapsbanken är tom — lägg till företagets fakta, dokument och policys först." });
    const focus = String(req.body?.focus || "").slice(0, 500);
    const sys = "Du är Simba och granskar företagets kunskapsbank (en delad kunskapsbas). " +
      "Utifrån sammanfattningen: bedöm (1) täckning och LUCKOR (vad saknas?), (2) motsägelser/dubbletter/föråldrat, " +
      "(3) strukturkvalitet på ämnena/grenarna, (4) VARFÖR banken ser ut som den gör, och (5) konkreta förbättringsförslag " +
      "(vad ska läggas till, slås ihop, delas upp, förtydligas). Svara på svenska, kort och strukturerat med rubriker.";
    const content = `Kunskapsbank: ${dg.count} poster i ämnena: ${dg.topics.join(", ")}.\n\nPoster:\n${dg.text}${focus ? `\n\nFokusera särskilt på: ${focus}` : ""}`;
    const resp = await withRetry(() => client.messages.create({ model: MODEL, max_tokens: 4000, system: sys, messages: [{ role: "user", content }] }), "vault-analyze");
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ text, count: dg.count });
  } catch (err) { console.error("[Simba] vault analyze failed:", err?.message || err); res.status(502).json({ error: "Kunde inte analysera kunskapsbanken." }); }
});

app.put("/api/vault/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Du har inte behörighet att ändra kunskapsbanken." });
  try {
    const entry = await updateEntry(orgOf(user), req.params.id, req.body || {}); // body may include file
    if (!entry) return res.status(404).json({ error: "Hittades inte." });
    res.json({ entry });
  } catch (err) { console.error("[Simba] vault update failed:", err?.message || err); res.status(err.status || 502).json({ error: err.message || "Kunde inte uppdatera posten." }); }
});

app.delete("/api/vault/:id", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!canWriteVault(user)) return res.status(403).json({ error: "Du har inte behörighet att ändra kunskapsbanken." });
  try { await deleteEntry(orgOf(user), req.params.id); res.json({ ok: true }); }
  catch (err) { console.error("[Simba] vault delete failed:", err?.message || err); res.status(502).json({ error: "Kunde inte ta bort posten." }); }
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
