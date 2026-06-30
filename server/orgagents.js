/*
 * Centralized organization agents — shared agents the whole org can see, whose
 * work is logged (activity log) and whose sensitive actions can require human
 * approval. First type: "time_reconciler" — collects monthly hours mailed to a
 * dedicated address and, on a set day, compiles and (after approval) emails a
 * summary to a chosen recipient.
 *
 * Org-scoped (per tenant). Postgres when DATABASE_URL is set; memory fallback.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

export const usingPostgres = Boolean(process.env.DATABASE_URL);

let pool = null;
let ready = null;
const agentsMem = new Map();   // orgKey -> Map(id -> agent)
const runsMem = [];            // {id, org_key, agent_id, at, status, summary, detail}
const apprMem = [];            // approvals

function makeSsl() {
  if (process.env.PGSSL_DISABLE) return false;
  if (process.env.PGSSL_CA) return { ca: process.env.PGSSL_CA, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

async function init() {
  if (!usingPostgres) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: makeSsl(), max: 5 });
  await pool.query(`CREATE TABLE IF NOT EXISTS simba_agents (
     id TEXT PRIMARY KEY, org_key TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
     config JSONB NOT NULL DEFAULT '{}'::jsonb, state JSONB NOT NULL DEFAULT '{}'::jsonb,
     enabled BOOLEAN NOT NULL DEFAULT true, created_by TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS simba_agent_runs (
     id TEXT PRIMARY KEY, org_key TEXT NOT NULL, agent_id TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(),
     status TEXT, summary TEXT, detail JSONB)`);
  await pool.query("CREATE INDEX IF NOT EXISTS simba_agent_runs_a ON simba_agent_runs (org_key, agent_id, at DESC)");
  await pool.query(`CREATE TABLE IF NOT EXISTS simba_agent_approvals (
     id TEXT PRIMARY KEY, org_key TEXT NOT NULL, agent_id TEXT NOT NULL, run_id TEXT, kind TEXT,
     payload JSONB, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ)`);
  await pool.query("CREATE INDEX IF NOT EXISTS simba_agent_appr ON simba_agent_approvals (org_key, status)");
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] orgagents init failed:", e.message); pool = null; });
  return ready;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);
function publicAgent(a) {
  return { id: a.id, name: a.name, type: a.type, config: a.config || {}, state: a.state || {}, enabled: a.enabled, created_by: a.created_by || "", updated_at: a.updated_at };
}

/* ---- Agents ------------------------------------------------------------- */
export async function listAgents(orgKey) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_agents WHERE org_key=$1 ORDER BY name", [orgKey]); return r.rows.map(publicAgent); }
  return [...(agentsMem.get(orgKey)?.values() || [])].map(publicAgent);
}
export async function getAgent(orgKey, id) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_agents WHERE org_key=$1 AND id=$2", [orgKey, id]); return r.rows[0] ? publicAgent(r.rows[0]) : null; }
  const a = agentsMem.get(orgKey)?.get(id); return a ? publicAgent(a) : null;
}
export async function createAgent(orgKey, { name, type, config, createdBy }) {
  await ensureReady();
  const a = { id: randomUUID(), org_key: orgKey, name: clean(name, 120) || "Agent", type: clean(type, 40) || "time_reconciler", config: config || {}, state: {}, enabled: true, created_by: clean(createdBy, 200), updated_at: new Date().toISOString() };
  if (pool) await pool.query("INSERT INTO simba_agents (id,org_key,name,type,config,state,enabled,created_by) VALUES ($1,$2,$3,$4,$5::jsonb,'{}'::jsonb,true,$6)", [a.id, orgKey, a.name, a.type, JSON.stringify(a.config), a.created_by]);
  else { if (!agentsMem.has(orgKey)) agentsMem.set(orgKey, new Map()); agentsMem.get(orgKey).set(a.id, a); }
  return publicAgent(a);
}
export async function updateAgent(orgKey, id, patch) {
  await ensureReady();
  const cur = await getAgent(orgKey, id);
  if (!cur) return null;
  const next = { name: patch.name != null ? clean(patch.name, 120) : cur.name, config: patch.config != null ? patch.config : cur.config, enabled: typeof patch.enabled === "boolean" ? patch.enabled : cur.enabled };
  if (pool) await pool.query("UPDATE simba_agents SET name=$3,config=$4::jsonb,enabled=$5,updated_at=now() WHERE org_key=$1 AND id=$2", [orgKey, id, next.name, JSON.stringify(next.config), next.enabled]);
  else Object.assign(agentsMem.get(orgKey).get(id), next, { updated_at: new Date().toISOString() });
  return await getAgent(orgKey, id);
}
export async function deleteAgent(orgKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_agents WHERE org_key=$1 AND id=$2", [orgKey, id]);
  else agentsMem.get(orgKey)?.delete(id);
}
export async function setAgentState(orgKey, id, patch) {
  await ensureReady();
  if (pool) await pool.query("UPDATE simba_agents SET state = state || $3::jsonb WHERE org_key=$1 AND id=$2", [orgKey, id, JSON.stringify(patch)]);
  else { const a = agentsMem.get(orgKey)?.get(id); if (a) a.state = { ...(a.state || {}), ...patch }; }
}
// All enabled agents across orgs (for the scheduler). Includes org_key.
export async function allEnabledAgents() {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_agents WHERE enabled=true"); return r.rows.map((a) => ({ ...publicAgent(a), org_key: a.org_key })); }
  const out = []; for (const [org, m] of agentsMem) for (const a of m.values()) if (a.enabled) out.push({ ...publicAgent(a), org_key: org }); return out;
}

/* ---- Activity log (runs) ----------------------------------------------- */
export async function logRun(orgKey, agentId, { status, summary, detail }) {
  await ensureReady();
  const run = { id: randomUUID(), org_key: orgKey, agent_id: agentId, at: new Date().toISOString(), status: clean(status, 40), summary: clean(summary, 600), detail: detail || {} };
  if (pool) await pool.query("INSERT INTO simba_agent_runs (id,org_key,agent_id,at,status,summary,detail) VALUES ($1,$2,$3,now(),$4,$5,$6::jsonb)", [run.id, orgKey, agentId, run.status, run.summary, JSON.stringify(run.detail)]);
  else { runsMem.push(run); if (runsMem.length > 5000) runsMem.shift(); }
  return run;
}
export async function listRuns(orgKey, agentId, limit = 20) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT id,agent_id,at,status,summary FROM simba_agent_runs WHERE org_key=$1 AND agent_id=$2 ORDER BY at DESC LIMIT $3", [orgKey, agentId, limit]); return r.rows; }
  return runsMem.filter((x) => x.org_key === orgKey && x.agent_id === agentId).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit);
}

/* ---- Approvals --------------------------------------------------------- */
export async function createApproval(orgKey, agentId, runId, kind, payload) {
  await ensureReady();
  const ap = { id: randomUUID(), org_key: orgKey, agent_id: agentId, run_id: runId, kind: clean(kind, 40), payload: payload || {}, status: "pending", created_at: new Date().toISOString() };
  if (pool) await pool.query("INSERT INTO simba_agent_approvals (id,org_key,agent_id,run_id,kind,payload,status) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending')", [ap.id, orgKey, agentId, runId, ap.kind, JSON.stringify(ap.payload)]);
  else apprMem.push(ap);
  return ap;
}
export async function listApprovals(orgKey, status = "pending") {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_agent_approvals WHERE org_key=$1 AND status=$2 ORDER BY created_at DESC LIMIT 100", [orgKey, status]); return r.rows; }
  return apprMem.filter((a) => a.org_key === orgKey && a.status === status);
}
export async function getApproval(orgKey, id) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_agent_approvals WHERE org_key=$1 AND id=$2", [orgKey, id]); return r.rows[0] || null; }
  return apprMem.find((a) => a.org_key === orgKey && a.id === id) || null;
}
export async function decideApproval(orgKey, id, status, decidedBy) {
  await ensureReady();
  if (pool) await pool.query("UPDATE simba_agent_approvals SET status=$3, decided_by=$4, decided_at=now() WHERE org_key=$1 AND id=$2", [orgKey, id, status, clean(decidedBy, 200)]);
  else { const a = apprMem.find((x) => x.org_key === orgKey && x.id === id); if (a) { a.status = status; a.decided_by = decidedBy; a.decided_at = new Date().toISOString(); } }
  return await getApproval(orgKey, id);
}
