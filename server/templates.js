/*
 * Org-shared prompt templates — reusable flows anyone in the tenant can run
 * ("Offert till kund", "Månadsrapport", …). Small org-scoped CRUD store; the
 * client inserts the chosen template into the composer.
 */
import { getPool, usingPostgres } from "./db.js";
import { randomUUID } from "node:crypto";

export { usingPostgres };

let pool = null;
let ready = null;
const mem = new Map(); // orgKey -> Map(id -> tpl)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_templates (
       id         TEXT PRIMARY KEY,
       org_key    TEXT NOT NULL,
       name       TEXT NOT NULL,
       prompt     TEXT NOT NULL,
       created_by TEXT,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_templates_org ON simba_templates (org_key)");
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] templates init failed:", e.message); pool = null; });
  return ready;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const pub = (t) => ({ id: t.id, name: t.name, prompt: t.prompt, created_by: t.created_by || "", updated_at: t.updated_at });

export async function listTemplates(orgKey) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_templates WHERE org_key=$1 ORDER BY name LIMIT 200", [orgKey]); return r.rows.map(pub); }
  return [...(mem.get(orgKey)?.values() || [])].sort((a, b) => a.name.localeCompare(b.name)).map(pub);
}

export async function createTemplate(orgKey, { name, prompt, createdBy }) {
  await ensureReady();
  const t = { id: randomUUID(), org_key: orgKey, name: clean(name, 120), prompt: clean(prompt, 6000), created_by: clean(createdBy, 200), updated_at: new Date().toISOString() };
  if (!t.name || !t.prompt) throw Object.assign(new Error("Mallen behöver namn och text."), { status: 400 });
  if (pool) await pool.query("INSERT INTO simba_templates (id,org_key,name,prompt,created_by) VALUES ($1,$2,$3,$4,$5)", [t.id, orgKey, t.name, t.prompt, t.created_by]);
  else { if (!mem.has(orgKey)) mem.set(orgKey, new Map()); mem.get(orgKey).set(t.id, t); }
  return pub(t);
}

export async function deleteTemplate(orgKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_templates WHERE org_key=$1 AND id=$2", [orgKey, id]);
  else mem.get(orgKey)?.delete(id);
}
