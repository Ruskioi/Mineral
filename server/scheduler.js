/*
 * Background scheduler for Simba's server-side agent.
 *
 * On an interval it picks up due jobs (jobs.js), and for each one acts as the
 * file's tenant via app-only Graph: download the .xlsx, run a focused agent loop
 * with the server-side Excel tools (xlsx-tools.js) plus web search/fetch, write
 * the file back, and record the outcome + next run.
 *
 * Opt-in: only starts when SIMBA_SCHEDULER=1 AND app-only Graph is configured.
 * Runs on a single instance — don't enable it on more than one replica or jobs
 * may run twice.
 */
import ExcelJS from "exceljs";
import { dueJobs, recordRun } from "./jobs.js";
import { appOnlyGraphToken, downloadDriveItem, uploadDriveItem, graphAppConfigured } from "./graph.js";
import { XLSX_TOOLS, executeXlsxTool } from "./xlsx-tools.js";

const TICK_MS = Number(process.env.SIMBA_SCHEDULER_TICK_MS || 60_000);
const JOB_FILE_MAX = 20 * 1024 * 1024;
const MAX_TURNS = 16;

const SCHED_SYSTEM = `Du är Simba som kör ett SCHEMALAGT jobb i bakgrunden, utan att användaren är närvarande.
Slutför uppgiften helt och hållet med verktygen och svara sedan med en KORT sammanfattning på svenska (vad du gjorde, viktiga siffror).
Be ALDRIG om förtydliganden — gör rimliga antaganden. Skriv konkreta värden (inte bara formler) för data som jobbet självt behöver kunna läsa, eftersom formler inte räknas om förrän filen öppnas i Excel.
Var sparsam med antal steg.`;

const WEB_TOOLS = [
  { type: "web_search_20260209", name: "web_search" },
  { type: "web_fetch_20260209", name: "web_fetch" },
];

let timer = null;
let running = false;

// Run one job end-to-end. Returns { status, result }.
async function runJob(client, model, job) {
  const [tid] = String(job.userKey || "").split(":");
  const { driveId, itemId } = job.target || {};
  if (!tid || !driveId || !itemId) return { status: "error", result: "Schemat saknar tenant eller målfil." };

  const token = await appOnlyGraphToken(tid);
  const { buffer, name } = await downloadDriveItem(token, driveId, itemId, JOB_FILE_MAX);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const messages = [{
    role: "user",
    content: `Schemalagt jobb mot filen "${name}".\n\nUppgift:\n${job.prompt}`,
  }];
  let dirty = false;
  let summary = "";

  for (let i = 0; i < MAX_TURNS; i++) {
    const resp = await client.messages.create({
      model, max_tokens: 8000, system: SCHED_SYSTEM,
      tools: [...XLSX_TOOLS, ...WEB_TOOLS], messages,
    });
    if (resp.stop_reason === "pause_turn") { // a server tool (web) is still working
      messages.push({ role: "assistant", content: resp.content });
      continue;
    }
    if (resp.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: resp.content });
      const results = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        let out;
        try {
          const r = executeXlsxTool(wb, block.name, block.input || {});
          if (r.dirty) dirty = true;
          out = r.result;
        } catch (e) { out = { error: e.message || String(e) }; }
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out), is_error: !!(out && out.error) });
      }
      messages.push({ role: "user", content: results });
      continue;
    }
    summary = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    break;
  }

  if (dirty) {
    const outBuf = await wb.xlsx.writeBuffer();
    await uploadDriveItem(token, driveId, itemId, Buffer.from(outBuf));
  }
  return { status: "ok", result: (dirty ? "" : "(inga ändringar) ") + (summary || "Klart.") };
}

async function tick(client, model) {
  if (running) return; // never overlap ticks
  running = true;
  try {
    const jobs = await dueJobs(Date.now());
    for (const job of jobs) {
      const ranAtMs = Date.now();
      try {
        const { status, result } = await runJob(client, model, job);
        await recordRun(job.id, { status, result, ranAtMs });
        console.log(`[Simba] job ${job.id} (${job.name}) -> ${status}`);
      } catch (e) {
        console.error(`[Simba] job ${job.id} failed:`, e?.message || e);
        await recordRun(job.id, { status: "error", result: (e?.message || "Okänt fel").slice(0, 400), ranAtMs });
      }
    }
  } catch (e) {
    console.error("[Simba] scheduler tick failed:", e?.message || e);
  } finally {
    running = false;
  }
}

export const schedulerEnabled = process.env.SIMBA_SCHEDULER === "1" && graphAppConfigured;

export function startScheduler(client, model) {
  if (!schedulerEnabled) return false;
  if (timer) return true;
  console.log(`[Simba] scheduler on (every ${Math.round(TICK_MS / 1000)}s)`);
  timer = setInterval(() => { tick(client, model); }, TICK_MS);
  timer.unref?.();
  return true;
}

export function stopScheduler() { if (timer) { clearInterval(timer); timer = null; } }
