/*
 * Uppdrag (missions) — goal-driven long jobs with a definition of done.
 *
 * The user states a GOAL and a RUBRIC ("klart när …"). Simba works server-side
 * in the background: research (web), company knowledge (vault) and data sources
 * (connectors), producing a markdown deliverable. A separate evaluator pass
 * grades the deliverable against the rubric; if it fails, the runner iterates
 * with the evaluator's feedback — up to maxIterations. Progress and the final
 * result are stored so the user can check in from any surface.
 *
 * Runs are fire-and-forget in-process (started at creation); a scheduler pass
 * re-queues missions stuck in "running" after a restart.
 */
import { getPool, usingPostgres } from "./db.js";
import { randomUUID } from "node:crypto";
import { retrieveForContext } from "./vault.js";
import { listConnectors, queryConnector } from "./connectors.js";

export { usingPostgres };

const MAX_ROUNDS_PER_ITER = 14; // model turns per build iteration (incl. tool pauses)
const MAX_ITER_CAP = 5;

let pool = null;
let ready = null;
const mem = new Map(); // userKey -> Map(id -> mission)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_missions (
       id         TEXT PRIMARY KEY,
       user_key   TEXT NOT NULL,
       org_key    TEXT NOT NULL,
       goal       TEXT NOT NULL,
       rubric     TEXT NOT NULL,
       status     TEXT NOT NULL DEFAULT 'queued',
       progress   JSONB NOT NULL DEFAULT '[]'::jsonb,
       result     TEXT,
       iterations INTEGER NOT NULL DEFAULT 0,
       max_iter   INTEGER NOT NULL DEFAULT 3,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_missions_user ON simba_missions (user_key, created_at DESC)");
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] missions init failed:", e.message); pool = null; });
  return ready;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const pub = (m) => ({
  id: m.id, goal: m.goal, rubric: m.rubric, status: m.status,
  progress: m.progress || [], result: m.result || "", iterations: m.iterations || 0,
  maxIter: m.max_iter, created_at: m.created_at, updated_at: m.updated_at,
});

export async function listMissions(userKey) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_missions WHERE user_key=$1 ORDER BY created_at DESC LIMIT 25", [userKey]); return r.rows.map(pub); }
  return [...(mem.get(userKey)?.values() || [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(pub);
}
export async function getMission(userKey, id) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_missions WHERE user_key=$1 AND id=$2", [userKey, id]); return r.rows[0] ? pub(r.rows[0]) : null; }
  const m = mem.get(userKey)?.get(id);
  return m ? pub(m) : null;
}

export async function createMission(userKey, orgKey, { goal, rubric, maxIter }) {
  await ensureReady();
  const m = {
    id: randomUUID(), user_key: userKey, org_key: orgKey,
    goal: clean(goal, 4000), rubric: clean(rubric, 2000) || "Målet är uppfyllt, komplett och konkret besvarat.",
    status: "queued", progress: [], result: null, iterations: 0,
    max_iter: Math.min(MAX_ITER_CAP, Math.max(1, Number(maxIter) || 3)),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (!m.goal) throw Object.assign(new Error("Uppdraget saknar mål."), { status: 400 });
  if (pool) await pool.query("INSERT INTO simba_missions (id,user_key,org_key,goal,rubric,status,max_iter) VALUES ($1,$2,$3,$4,$5,'queued',$6)", [m.id, userKey, orgKey, m.goal, m.rubric, m.max_iter]);
  else { if (!mem.has(userKey)) mem.set(userKey, new Map()); mem.get(userKey).set(m.id, m); }
  return pub(m);
}

export async function cancelMission(userKey, id) {
  await ensureReady();
  if (pool) await pool.query("UPDATE simba_missions SET status='cancelled', updated_at=now() WHERE user_key=$1 AND id=$2 AND status IN ('queued','running')", [userKey, id]);
  else { const m = mem.get(userKey)?.get(id); if (m && ["queued", "running"].includes(m.status)) m.status = "cancelled"; }
}

async function update(m, patch) {
  Object.assign(m, patch, { updated_at: new Date().toISOString() });
  if (pool) {
    await pool.query(
      "UPDATE simba_missions SET status=$2, progress=$3::jsonb, result=$4, iterations=$5, updated_at=now() WHERE id=$1",
      [m.id, m.status, JSON.stringify(m.progress || []), m.result, m.iterations]
    );
  }
}
async function raw(userKey, id) {
  if (pool) { const r = await pool.query("SELECT * FROM simba_missions WHERE user_key=$1 AND id=$2", [userKey, id]); return r.rows[0] || null; }
  return mem.get(userKey)?.get(id) || null;
}
async function stillWanted(userKey, id) {
  const m = await raw(userKey, id);
  return m && m.status === "running";
}

function note(m, text) {
  m.progress = [...(m.progress || []), { at: new Date().toISOString(), text: clean(text, 300) }].slice(-40);
}

/* The mission's tool belt: web (server tools) + company knowledge + data
 * sources as custom tools executed inline. Read-only by design — a mission
 * produces a deliverable, it doesn't mutate systems. */
function missionTools() {
  return [
    { type: "web_search_20260209", name: "web_search", max_uses: 15 },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: 12 },
    { name: "search_vault", description: "Sök i företagets kunskapsbank (delade fakta, policys, synkade dokument).",
      input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "query_data_source", description: "Hämta data från en kopplad datakälla (ekonomisystem etc). Ange källans namn/id och endpointens nyckel.",
      input_schema: { type: "object", properties: { source: { type: "string" }, endpoint: { type: "string" }, params: { type: "object" } }, required: ["source", "endpoint"] } },
    { name: "list_data_sources", description: "Lista kopplade datakällor och deras endpoints.", input_schema: { type: "object", properties: {} } },
  ];
}
async function execMissionTool(orgKey, name, input) {
  try {
    if (name === "search_vault") return { context: (await retrieveForContext(orgKey, String(input?.query || ""), 5000)) || "(inga träffar)" };
    if (name === "list_data_sources") return { sources: await listConnectors(orgKey) };
    if (name === "query_data_source") return await queryConnector(orgKey, input?.source, input?.endpoint, input?.params || {});
    return { error: `Okänt verktyg ${name}` };
  } catch (e) { return { error: e?.message || String(e) }; }
}

const BUILD_SYSTEM =
  "Du utför ett UPPDRAG åt användaren, självständigt och utan följdfrågor — gör rimliga antaganden och redovisa dem. " +
  "Använd verktygen (webb, kunskapsbank, datakällor) för att samla underlag. Leverera sedan SLUTRESULTATET som en " +
  "komplett, välstrukturerad svensk markdown-rapport/leverabel med källor där det är relevant. Svara med HELA leverabeln.";

const EVAL_SYSTEM =
  'Du är en strikt granskare. Bedöm leverabeln mot kravlistan. Svara ENBART med JSON: ' +
  '{"pass":true/false,"score":0-100,"feedback":"<konkret vad som saknas/brister, punktvis, på svenska>"}. ' +
  "Underkänn hellre en gång för mycket än släpp igenom något halvfärdigt.";

// Run one mission to completion (fire-and-forget; safe to await in background).
export async function runMission(client, model, userKey, id) {
  const m = await raw(userKey, id);
  if (!m || !["queued", "running"].includes(m.status)) return;
  m.status = "running";
  note(m, "Uppdraget startar.");
  await update(m, {});

  let feedback = "";
  try {
    for (let iter = 1; iter <= m.max_iter; iter++) {
      if (!(await stillWanted(userKey, id))) return; // cancelled mid-run
      m.iterations = iter;
      note(m, `Iteration ${iter}: bygger leverabeln${feedback ? " utifrån granskarens feedback" : ""}.`);
      await update(m, {});

      const messages = [{
        role: "user",
        content: `UPPDRAG:\n${m.goal}\n\nDEFINITION AV KLART (granskas mot detta):\n${m.rubric}` +
          (feedback ? `\n\nGRANSKARENS FEEDBACK FRÅN FÖRRA FÖRSÖKET (åtgärda allt):\n${feedback}` : ""),
      }];
      let deliverable = "";
      for (let round = 0; round < MAX_ROUNDS_PER_ITER; round++) {
        const resp = await client.messages.create({
          model, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "high" },
          system: BUILD_SYSTEM, tools: missionTools(), messages,
        });
        if (resp.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: resp.content }); continue; }
        if (resp.stop_reason === "tool_use") {
          messages.push({ role: "assistant", content: resp.content });
          const results = [];
          for (const b of resp.content) {
            if (b.type !== "tool_use") continue;
            note(m, `Använder ${b.name}${b.input?.query ? `: ${String(b.input.query).slice(0, 60)}` : ""}`);
            const out = await execMissionTool(m.org_key, b.name, b.input || {});
            results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 60000), is_error: !!out?.error });
          }
          await update(m, {});
          messages.push({ role: "user", content: results });
          continue;
        }
        deliverable = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
        break;
      }
      if (!deliverable) { feedback = "Ingen komplett leverabel producerades — leverera hela resultatet i ett svar."; continue; }

      note(m, `Iteration ${iter}: granskar mot kravlistan.`);
      await update(m, { result: deliverable });
      const ev = await client.messages.create({
        model, max_tokens: 1500, system: EVAL_SYSTEM,
        messages: [{ role: "user", content: `KRAVLISTA:\n${m.rubric}\n\nUPPDRAG:\n${m.goal}\n\nLEVERABEL:\n${deliverable.slice(0, 60000)}` }],
      });
      const evText = ev.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      let verdict = { pass: true, score: 0, feedback: "" };
      try { const mm = evText.match(/\{[\s\S]*\}/); if (mm) verdict = JSON.parse(mm[0]); } catch { /* treat as pass */ }
      if (verdict.pass) {
        note(m, `Godkänt av granskaren${verdict.score ? ` (${verdict.score}/100)` : ""}. Klart.`);
        await update(m, { status: "done", result: deliverable });
        return;
      }
      feedback = clean(verdict.feedback, 2000) || "Uppfyller inte kraven — förbättra och komplettera.";
      note(m, `Underkänt (${verdict.score ?? "?"}/100): ${feedback.slice(0, 120)}…`);
      await update(m, {});
    }
    note(m, "Max antal iterationer nått — levererar bästa versionen med reservation.");
    await update(m, { status: "done_partial" });
  } catch (e) {
    console.error(`[Simba] mission ${id} failed:`, e?.message || e);
    note(m, `Fel: ${(e?.message || "okänt").slice(0, 200)}`);
    await update(m, { status: "error" });
  }
}
