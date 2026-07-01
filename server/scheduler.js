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
import { dueJobs, recordRun, claimJob } from "./jobs.js";
import { appOnlyGraphToken, downloadDriveItem, uploadDriveItem, sendMailAsUser, listMailboxMessages, getMailboxAttachments, graphAppConfigured } from "./graph.js";
import { allEnabledAgents, setAgentState, logRun, createApproval } from "./orgagents.js";
import { buildWriteRequests } from "./connectors.js";
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
      // Claim it first (lease 15 min) so a second instance won't double-run it.
      if (!(await claimJob(job.id, Date.now() + 15 * 60_000))) continue;
      const ranAtMs = Date.now();
      let status = "error", result = "Okänt fel";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          ({ status, result } = await runJob(client, model, job));
          break;
        } catch (e) {
          result = (e?.message || "Okänt fel").slice(0, 400);
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 3000)); continue; } // one retry
          console.error(`[Simba] job ${job.id} failed:`, e?.message || e);
        }
      }
      await recordRun(job.id, { status, result, ranAtMs }); // sets the real next_run
      await notify(job, status, result).catch((e) => console.error(`[Simba] notify failed for ${job.id}:`, e?.message || e));
      console.log(`[Simba] job ${job.id} (${job.name}) -> ${status}`);
    }
  } catch (e) {
    console.error("[Simba] scheduler tick failed:", e?.message || e);
  } finally {
    running = false;
  }
  await tickAgents(client, model); // centralized org agents (time reconciler, …)
}

// Email the job's owner a short summary of the run (best effort, opt-in per job).
async function notify(job, status, result) {
  const t = job.target || {};
  if (!t.notify || !t.email) return;
  const [tid, oid] = String(job.userKey || "").split(":");
  if (!tid || !oid) return;
  const token = await appOnlyGraphToken(tid);
  const ok = status === "ok";
  const subject = `Simba: ${job.name} ${ok ? "klart" : "misslyckades"}`;
  const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const html = `<p>Ditt schemalagda jobb <b>${esc(job.name)}</b> mot <b>${esc(t.fileName)}</b> ${ok ? "kördes klart" : "misslyckades"}.</p>` +
    `<p>${esc(result)}</p><hr><p style="color:#888;font-size:12px">Skickat automatiskt av Simba AI.</p>`;
  await sendMailAsUser(token, oid, t.email, subject, html);
}

const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Run one centralized org agent now, dispatching by type.
export async function runOrgAgent(client, model, agent) {
  if (agent.type === "time_reconciler") return runTimeReconciler(client, model, agent);
  if (agent.type === "supplier_invoice") return runSupplierInvoice(client, model, agent);
  return { status: "skipped", summary: "Okänd agenttyp." };
}

async function runTimeReconciler(client, model, agent) {
  const tid = agent.org_key;
  const cfg = agent.config || {};
  if (!cfg.mailbox || !cfg.recipient) return { status: "error", summary: "Saknar mailbox eller mottagare." };
  const offset = Number.isFinite(cfg.tzOffset) ? cfg.tzOffset : 0;
  const now = new Date(Date.now() - offset * 60_000);
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const sinceIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const dateStr = now.toISOString().slice(0, 10);

  const token = await appOnlyGraphToken(tid);
  const msgs = await listMailboxMessages(token, cfg.mailbox, sinceIso);
  const submissions = msgs.map((m) => `Från: ${m.fromName || m.from} <${m.from}> (${m.received})\n${m.body}`).join("\n\n---\n\n").slice(0, 40000);

  const sys = "Du är en tidsavstämmare. Läs de inrapporterade timmarna och svara ENBART med ett JSON-objekt: " +
    '{"summary":"<en kort, proffsig svensk sammanställning: tabell Person | Timmar, total, samt oklarheter/vilka som inte rapporterat>","rows":[{"person":"<namn>","email":"<avsändarens e-post>","hours":<antal timmar som tal>}]}. ' +
    "Hitta ALDRIG på siffror; utelämna en person ur rows om timmar saknas.";
  const content = `Period: ${period}. Mejl inkomna till ${cfg.mailbox}:\n\n${submissions || "(inga mejl inkomna denna period)"}`;
  const resp = await client.messages.create({ model, max_tokens: 3000, system: sys, messages: [{ role: "user", content }] });
  const rawText = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  const parsed = parseJsonObject(rawText) || {};
  const bodyText = (parsed.summary && String(parsed.summary).trim()) || rawText || "Inga timmar inrapporterade denna period.";
  const rows = Array.isArray(parsed.rows) ? parsed.rows.filter((r) => r && r.person && Number.isFinite(Number(r.hours))) : [];
  const subject = `Tidsammanställning ${period}`;

  const run = await logRun(tid, agent.id, { status: "compiled", summary: `Sammanställde ${msgs.length} inrapporteringar för ${period}`, detail: { count: msgs.length, period, rows } });

  // If a data source is linked (e.g. NEXT), post the hours there via an approval —
  // writes into a system of record ALWAYS require a human to approve the exact rows.
  const post = cfg.post || {};
  if (post.connectorId && post.endpointKey && rows.length) {
    try {
      const values = rows.map((r) => ({ person: r.person, email: r.email || "", hours: Number(r.hours), period, date: dateStr }));
      const built = await buildWriteRequests(tid, post.connectorId, post.endpointKey, values);
      await createApproval(tid, agent.id, run.id, "connector_write", {
        connectorId: built.connectorId, endpointKey: built.endpointKey, connectorName: built.connectorName,
        endpointLabel: built.endpointLabel, method: built.method, period, rows, bodies: built.bodies,
      });
      return { status: "awaiting_approval", summary: `Väntar på godkännande – registrera ${rows.length} tidsposter i ${built.connectorName}`, period };
    } catch (e) {
      // Fall back to the email summary if the mapping/template is misconfigured.
      await logRun(tid, agent.id, { status: "error", summary: `Kunde inte förbereda skrivning: ${(e?.message || e).toString().slice(0, 200)}` });
    }
  }

  if (cfg.requireApproval !== false) {
    await createApproval(tid, agent.id, run.id, "send_email", { to: cfg.recipient, subject, body: bodyText, mailbox: cfg.mailbox });
    return { status: "awaiting_approval", summary: `Väntar på godkännande – ${msgs.length} inrapporteringar för ${period}`, period };
  }
  await sendMailAsUser(token, cfg.mailbox, cfg.recipient, subject, `<pre style="white-space:pre-wrap;font-family:system-ui">${esc(bodyText)}</pre>`);
  await logRun(tid, agent.id, { status: "sent", summary: `Skickade sammanställningen till ${cfg.recipient}` });
  return { status: "sent", summary: `Skickade till ${cfg.recipient}`, period };
}

/* ---- Supplier-invoice agent (leverantörsfakturor) -----------------------
 * Suppliers email invoices (PDF/image) to a dedicated address. The agent reads
 * the new ones, has the model extract the key fields, compiles an accounts-
 * payable summary, and (after approval) emails it to the finance contact. It
 * dedupes by message id and persists its own cursor so manual and scheduled
 * runs never double-count. Read-only towards finance systems — a human attests. */

// Pull the first JSON object out of a model reply (tolerant of prose/fences).
function parseJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const INVOICE_SYSTEM = `Du läser EN leverantörsfaktura (bifogad som PDF eller bild) och extraherar fälten.
Svara ENBART med ett giltigt JSON-objekt, inga förklaringar. Hitta ALDRIG på värden — använd tom sträng om ett fält saknas.`;

async function extractInvoice(client, model, file) {
  const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name || "");
  if (!file.data) return null;
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } }
    : { type: "image", source: { type: "base64", media_type: file.type || "image/png", data: file.data } };
  const instruction = `Extrahera fakturafält ur "${file.name}". Returnera JSON med nycklarna: ` +
    `supplier, invoice_no, invoice_date, due_date, amount_excl_vat, vat, amount_incl_vat, currency, ocr, bankgiro, plusgiro, iban, notes.`;
  const resp = await client.messages.create({
    model, max_tokens: 1200, system: INVOICE_SYSTEM,
    messages: [{ role: "user", content: [block, { type: "text", text: instruction }] }],
  });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return parseJsonObject(text);
}

function formatInvoiceSummary(invoices) {
  const lines = invoices.map((inv, i) => {
    const amt = inv.amount_incl_vat || inv.amount_excl_vat || "?";
    return `${i + 1}. ${inv.supplier || "Okänd leverantör"} — fakturanr ${inv.invoice_no || "?"}\n` +
      `   Belopp: ${amt} ${inv.currency || ""}  ·  Förfaller: ${inv.due_date || "?"}  ·  OCR: ${inv.ocr || "-"}\n` +
      `   Betalning: ${[inv.bankgiro && "BG " + inv.bankgiro, inv.plusgiro && "PG " + inv.plusgiro, inv.iban && "IBAN " + inv.iban].filter(Boolean).join(", ") || "-"}\n` +
      `   Från: ${inv.from || "?"} · Fil: ${inv.file || "?"}${inv.notes ? `\n   Notering: ${inv.notes}` : ""}`;
  });
  return `Nya leverantörsfakturor att attestera (${invoices.length} st):\n\n${lines.join("\n\n")}\n\n` +
    `Granska och attestera i ert ekonomisystem. Simba läser fakturorna men registrerar eller betalar dem inte automatiskt.`;
}

async function runSupplierInvoice(client, model, agent) {
  const tid = agent.org_key;
  const cfg = agent.config || {};
  if (!cfg.mailbox || !cfg.recipient) return { status: "error", summary: "Saknar mailbox eller mottagare." };
  const state = agent.state || {};
  const seen = new Set(Array.isArray(state.seenIds) ? state.seenIds : []);

  const token = await appOnlyGraphToken(tid);
  // Look back from the last check (with a buffer) or 21 days on the first run.
  const since = state.lastCheck
    ? new Date(Date.parse(state.lastCheck) - 6 * 3600_000)
    : new Date(Date.now() - 21 * 24 * 3600_000);
  const msgs = await listMailboxMessages(token, cfg.mailbox, since.toISOString());
  const fresh = msgs.filter((m) => m.hasAttachments && !seen.has(m.id)).slice(0, 12);

  const invoices = [];
  for (const m of fresh) {
    let atts = [];
    try { atts = await getMailboxAttachments(token, cfg.mailbox, m.id); } catch { atts = []; }
    const files = atts.filter((a) => /pdf/i.test(a.type) || /^image\//i.test(a.type) || /\.pdf$/i.test(a.name || ""));
    for (const f of files) {
      try {
        const data = await extractInvoice(client, model, f);
        if (data) invoices.push({ ...data, from: m.from, file: f.name, received: m.received });
      } catch (e) { console.error(`[Simba] invoice parse failed (${f.name}):`, e?.message || e); }
    }
    seen.add(m.id);
  }

  // Persist the cursor regardless of outcome so we never re-read the same mail.
  await setAgentState(tid, agent.id, { lastCheck: new Date().toISOString(), seenIds: [...seen].slice(-500) });

  if (!invoices.length) {
    await logRun(tid, agent.id, { status: "checked", summary: `Inga nya fakturor (granskade ${fresh.length} mejl)` });
    return { status: "checked", summary: `Inga nya fakturor` };
  }

  const summaryText = formatInvoiceSummary(invoices);
  const subject = `Leverantörsfakturor – ${invoices.length} nya att attestera`;
  const run = await logRun(tid, agent.id, { status: "compiled", summary: `Läste ${invoices.length} faktura(or) ur ${fresh.length} mejl`, detail: { invoices } });

  if (cfg.requireApproval !== false) {
    await createApproval(tid, agent.id, run.id, "send_email", { to: cfg.recipient, subject, body: summaryText, mailbox: cfg.mailbox });
    return { status: "awaiting_approval", summary: `Väntar på godkännande – ${invoices.length} fakturor` };
  }
  await sendMailAsUser(token, cfg.mailbox, cfg.recipient, subject, `<pre style="white-space:pre-wrap;font-family:system-ui">${esc(summaryText)}</pre>`);
  await logRun(tid, agent.id, { status: "sent", summary: `Skickade fakturasammanställning till ${cfg.recipient}` });
  return { status: "sent", summary: `Skickade ${invoices.length} fakturor till ${cfg.recipient}` };
}

// On each tick, run due org agents: time reconciler (monthly, on/after runDay)
// and supplier-invoice (polls its inbox every cfg.intervalMinutes).
async function tickAgents(client, model) {
  let agents = [];
  try { agents = await allEnabledAgents(); } catch (e) { console.error("[Simba] agents list failed:", e?.message || e); return; }
  for (const a of agents) {
    const cfg = a.config || {};
    try {
      if (a.type === "time_reconciler") {
        const offset = Number.isFinite(cfg.tzOffset) ? cfg.tzOffset : 0;
        const now = new Date(Date.now() - offset * 60_000);
        const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
        if (now.getUTCDate() < (Number(cfg.runDay) || 25)) continue;
        if ((a.state || {}).lastPeriod === period) continue; // already handled this month
        const res = await runOrgAgent(client, model, a);
        await setAgentState(a.org_key, a.id, { lastPeriod: period, lastResult: res.status });
        console.log(`[Simba] agent ${a.id} (${a.name}) -> ${res.status}`);
      } else if (a.type === "supplier_invoice") {
        const everyMs = Math.max(5, Number(cfg.intervalMinutes) || 30) * 60_000;
        const last = (a.state || {}).lastCheck ? Date.parse(a.state.lastCheck) : 0;
        if (Date.now() - last < everyMs) continue; // not due yet
        const res = await runOrgAgent(client, model, a); // persists its own cursor
        await setAgentState(a.org_key, a.id, { lastResult: res.status });
        console.log(`[Simba] agent ${a.id} (${a.name}) -> ${res.status}`);
      }
    } catch (e) {
      console.error(`[Simba] agent ${a.id} failed:`, e?.message || e);
      await logRun(a.org_key, a.id, { status: "error", summary: (e?.message || "Fel").slice(0, 300) }).catch(() => {});
    }
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
