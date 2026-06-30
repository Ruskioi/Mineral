/*
 * Server-side Excel tools for the scheduled agent.
 *
 * Unlike the task pane (which edits a LIVE workbook via Office.js), a scheduled
 * job edits the .xlsx FILE directly with ExcelJS — read it, mutate cells, write
 * it back. This is what lets Simba refresh a workbook when no Excel window is
 * open. The toolset is a focused subset of the live tools.
 *
 * Caveat: ExcelJS does not recalculate formulas. Formulas you write are stored
 * and recalc when a human next opens the file in Excel; values you READ back in
 * the same run reflect the last result Excel saved (may be stale). So prefer
 * writing concrete values for anything the job itself needs to reason about.
 */

// A1 helpers -----------------------------------------------------------------
function colToNum(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function numToCol(n) {
  let s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
// Returns { sheetName|null, r1, c1, r2, c2 } (1-based, inclusive).
function parseAddress(address) {
  let a = String(address || "").trim();
  let sheetName = null;
  if (a.includes("!")) { const [s, ref] = a.split("!"); sheetName = s.replace(/^'|'$/g, ""); a = ref; }
  const cell = /^([A-Za-z]+)(\d+)$/;
  const range = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/;
  let m;
  if ((m = range.exec(a))) return { sheetName, c1: colToNum(m[1]), r1: +m[2], c2: colToNum(m[3]), r2: +m[4] };
  if ((m = cell.exec(a))) { const c = colToNum(m[1]), r = +m[2]; return { sheetName, c1: c, r1: r, c2: c, r2: r }; }
  throw new Error(`Ogiltig adress: ${address}`);
}
function normalize(p) {
  return { c1: Math.min(p.c1, p.c2), c2: Math.max(p.c1, p.c2), r1: Math.min(p.r1, p.r2), r2: Math.max(p.r1, p.r2), sheetName: p.sheetName };
}

function cellOut(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("result" in value) return value.result ?? "";
    if ("text" in value) return value.text ?? "";
    if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((t) => t.text).join("");
    if ("formula" in value) return null; // formula with no cached result
    if ("error" in value) return value.error;
    return "";
  }
  return value;
}

function pickSheet(wb, name) {
  if (name) {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`Bladet "${name}" finns inte.`);
    return ws;
  }
  return wb.worksheets[0];
}

const MAX_CELLS = 50_000;

// Tool schemas advertised to the model for scheduled runs.
export const XLSX_TOOLS = [
  { name: "list_sheets", description: "List all worksheet names in the workbook.",
    input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_sheet_info", description: "Get a sheet's used dimensions (rows/columns).",
    input_schema: { type: "object", properties: { sheet: { type: "string", description: "Sheet name (default first)." } } } },
  { name: "read_range", description: "Read the values of an A1 range. Formula cells return their last cached result.",
    input_schema: { type: "object", properties: {
      address: { type: "string", description: "A1 range, optionally Sheet!-qualified." },
      sheet: { type: "string", description: "Sheet name if address is unqualified (default first)." },
    }, required: ["address"] } },
  { name: "write_range", description: "Write a 2D array of values to an A1 range (top-left anchored).",
    input_schema: { type: "object", properties: {
      address: { type: "string" }, sheet: { type: "string" },
      values: { type: "array", description: "2D array (rows of columns).", items: { type: "array", items: {} } },
    }, required: ["address", "values"] } },
  { name: "set_formula", description: "Set one formula (without '=') into a cell or fill it across a range.",
    input_schema: { type: "object", properties: {
      address: { type: "string" }, sheet: { type: "string" },
      formula: { type: "string", description: "Formula text without leading '='." },
    }, required: ["address", "formula"] } },
  { name: "set_formulas", description: "Set a 2D array of per-cell formulas (without '=') across a range.",
    input_schema: { type: "object", properties: {
      address: { type: "string" }, sheet: { type: "string" },
      formulas: { type: "array", items: { type: "array", items: { type: "string" } } },
    }, required: ["address", "formulas"] } },
  { name: "clear_range", description: "Clear the values of an A1 range.",
    input_schema: { type: "object", properties: { address: { type: "string" }, sheet: { type: "string" } }, required: ["address"] } },
  { name: "format_range", description: "Apply basic formatting to a range: bold, fill colour, font colour, number format, alignment.",
    input_schema: { type: "object", properties: {
      address: { type: "string" }, sheet: { type: "string" },
      bold: { type: "boolean" }, fill: { type: "string", description: "Hex fill, e.g. #1F7A4D." },
      font_color: { type: "string", description: "Hex font colour." },
      number_format: { type: "string", description: "e.g. '#,##0', '0.0%', 'yyyy-mm-dd'." },
      align: { type: "string", description: "left | center | right." },
    }, required: ["address"] } },
  { name: "add_sheet", description: "Add a new worksheet.",
    input_schema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "find", description: "Find cells containing text on a sheet; returns addresses.",
    input_schema: { type: "object", properties: {
      query: { type: "string" }, sheet: { type: "string" },
    }, required: ["query"] } },
];

function hex(c) { return String(c || "").replace(/^#/, "").toUpperCase().padStart(6, "0").slice(0, 6); }
function argb(c) { return "FF" + hex(c); }

// Execute a tool against an in-memory ExcelJS workbook. Mutating tools set
// `dirty` on the returned envelope so the runner knows to upload.
export function executeXlsxTool(wb, name, input = {}) {
  switch (name) {
    case "list_sheets":
      return { result: { sheets: wb.worksheets.map((w) => w.name) } };

    case "get_sheet_info": {
      const ws = pickSheet(wb, input.sheet);
      return { result: { sheet: ws.name, rows: ws.actualRowCount || ws.rowCount || 0, columns: ws.actualColumnCount || ws.columnCount || 0 } };
    }

    case "read_range": {
      const p = normalize(parseAddress(input.address));
      const ws = pickSheet(wb, p.sheetName || input.sheet);
      if ((p.r2 - p.r1 + 1) * (p.c2 - p.c1 + 1) > MAX_CELLS) return { result: { error: "Området är för stort att läsa." } };
      const values = [];
      for (let r = p.r1; r <= p.r2; r++) {
        const row = [];
        for (let c = p.c1; c <= p.c2; c++) row.push(cellOut(ws.getCell(r, c).value));
        values.push(row);
      }
      return { result: { address: input.address, values } };
    }

    case "write_range": {
      const p = normalize(parseAddress(input.address));
      const ws = pickSheet(wb, p.sheetName || input.sheet);
      const vals = Array.isArray(input.values) ? input.values : [];
      if (!vals.length || !Array.isArray(vals[0])) return { result: { error: "values måste vara en 2D-array." } };
      if (vals.length * vals[0].length > MAX_CELLS) return { result: { error: "För många celler att skriva." } };
      for (let i = 0; i < vals.length; i++) {
        const row = vals[i];
        for (let j = 0; j < row.length; j++) ws.getCell(p.r1 + i, p.c1 + j).value = row[j] ?? null;
      }
      return { result: { written: true, rows: vals.length, columns: vals[0].length }, dirty: true };
    }

    case "set_formula": {
      const p = normalize(parseAddress(input.address));
      const ws = pickSheet(wb, p.sheetName || input.sheet);
      const f = String(input.formula || "").replace(/^=/, "");
      for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) ws.getCell(r, c).value = { formula: f };
      return { result: { applied: true, formula: f }, dirty: true };
    }

    case "set_formulas": {
      const p = normalize(parseAddress(input.address));
      const ws = pickSheet(wb, p.sheetName || input.sheet);
      const fs = Array.isArray(input.formulas) ? input.formulas : [];
      if (!fs.length || !Array.isArray(fs[0])) return { result: { error: "formulas måste vara en 2D-array." } };
      for (let i = 0; i < fs.length; i++) for (let j = 0; j < fs[i].length; j++) {
        const f = String(fs[i][j] || "").replace(/^=/, "");
        if (f) ws.getCell(p.r1 + i, p.c1 + j).value = { formula: f };
      }
      return { result: { applied: true, rows: fs.length }, dirty: true };
    }

    case "clear_range": {
      const p = normalize(parseAddress(input.address));
      const ws = pickSheet(wb, p.sheetName || input.sheet);
      for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) ws.getCell(r, c).value = null;
      return { result: { cleared: true }, dirty: true };
    }

    case "format_range": {
      const p = normalize(parseAddress(input.address));
      const ws = pickSheet(wb, p.sheetName || input.sheet);
      for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) {
        const cell = ws.getCell(r, c);
        if (typeof input.bold === "boolean" || input.font_color) cell.font = { ...(cell.font || {}), ...(typeof input.bold === "boolean" ? { bold: input.bold } : {}), ...(input.font_color ? { color: { argb: argb(input.font_color) } } : {}) };
        if (input.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(input.fill) } };
        if (input.number_format) cell.numFmt = input.number_format;
        if (input.align) cell.alignment = { ...(cell.alignment || {}), horizontal: input.align };
      }
      return { result: { formatted: true }, dirty: true };
    }

    case "add_sheet": {
      const ws = wb.addWorksheet(String(input.name || "").slice(0, 31) || undefined);
      return { result: { added: true, sheet: ws.name }, dirty: true };
    }

    case "find": {
      const ws = pickSheet(wb, input.sheet);
      const q = String(input.query || "").toLowerCase();
      const matches = [];
      ws.eachRow({ includeEmpty: false }, (row, rNum) => {
        row.eachCell({ includeEmpty: false }, (cell, cNum) => {
          if (matches.length >= 200) return;
          const v = cellOut(cell.value);
          if (v != null && String(v).toLowerCase().includes(q)) matches.push(`${numToCol(cNum)}${rNum}`);
        });
      });
      return { result: { matches, count: matches.length } };
    }

    default:
      return { result: { error: `Okänt verktyg ${name}` } };
  }
}
