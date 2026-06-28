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
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";

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

You help the user understand and edit their spreadsheet. You can call tools to read
and write the workbook — use them rather than guessing about the user's data.

Guidelines:
- When a question is about the user's data, read the relevant range first.
- The user's current selection is often appended to their message as
  "[Current selection: ...]". Prefer it when they say "this", "here", "the selection".
- Range addresses are A1-style ("B2:D10"), optionally sheet-qualified ("Sheet2!A1:C3").
- write_range expects a 2D array of values matching the target shape.
- set_formula broadcasts one Excel formula string (e.g. "=SUM(B2:B100)") across the range.
- Before any edit, briefly say what you're about to change. After editing, confirm what changed.
- If the user has turned off sheet editing, a write tool returns {skipped:true}. Explain the
  formula or steps instead, and tell them to enable editing to apply it.
- Keep replies concise and practical. Use Excel formula syntax the user can paste.`;

const TOOLS = [
  {
    name: "get_selection",
    description:
      "Get the address, dimensions, and values of the user's currently selected range.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "read_range",
    description: "Read the values of a specific A1-style range, e.g. 'A1:C20' or 'Sheet2!A1:B5'.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "A1-style range address." },
      },
      required: ["address"],
      additionalProperties: false,
    },
  },
  {
    name: "write_range",
    description:
      "Write a 2D array of values into a range. The values array shape must match the range.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "A1-style target range." },
        values: {
          type: "array",
          description: "2D array of cell values (rows of columns).",
          items: { type: "array", items: {} },
        },
      },
      required: ["address", "values"],
      additionalProperties: false,
    },
  },
  {
    name: "set_formula",
    description:
      "Set a single Excel formula across every cell in a range, e.g. address 'D2:D100', formula '=B2*C2'.",
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "A1-style target range." },
        formula: { type: "string", description: "Excel formula starting with '='." },
      },
      required: ["address", "formula"],
      additionalProperties: false,
    },
  },
  {
    name: "get_sheet_info",
    description: "Get the active sheet name and its used range dimensions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

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
  console.log(`[Simba] backend listening on http://localhost:${PORT}  (model: ${MODEL})`);
});
