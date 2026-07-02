/*
 * Handoffs — "gör det här i Excel" from the standalone Simba app.
 *
 * The app can't touch a spreadsheet (no Office.js), but the Excel add-in can.
 * So the app queues a task here, opens Excel for the user, and the Simba
 * panel inside Excel claims the task and runs it with its sheet tools — then
 * reports the result back so the app can tell the user it's done.
 *
 * Small and safe by design: per-user (same signed-in identity on both ends),
 * pending tasks expire after 15 minutes (never run a stale task hours later),
 * and claiming is atomic so two open workbooks can't both run it.
 */
import { getPool, usingPostgres } from "./db.js";
import { randomUUID } from "node:crypto";

export { usingPostgres };

const PENDING_TTL_MS = 15 * 60_000; // unclaimed tasks go stale after this
const KEEP = 20;                    // recent handoffs kept per user

let pool = null;
let ready = null;
const mem = new Map(); // userKey -> Map(id -> handoff)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_handoffs (
       id         TEXT PRIMARY KEY,
       user_key   TEXT NOT NULL,
       target     TEXT NOT NULL DEFAULT 'excel',
       task       TEXT NOT NULL,
       status     TEXT NOT NULL DEFAULT 'pending',
       result     TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_handoffs_user ON simba_handoffs (user_key, created_at DESC)");
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] handoffs init failed:", e.message); pool = null; });
  return ready;
}

const pub = (h) => ({ id: h.id, target: h.target, task: h.task, status: h.status, result: h.result || "", created_at: h.created_at });
const freshCutoff = () => new Date(Date.now() - PENDING_TTL_MS).toISOString();

export async function createHandoff(userKey, target, task) {
  await ensureReady();
  const h = {
    id: randomUUID(), user_key: userKey,
    target: ["excel", "word"].includes(target) ? target : "excel",
    task: String(task || "").trim().slice(0, 4000),
    status: "pending", result: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  if (!h.task) throw Object.assign(new Error("Uppgiften är tom."), { status: 400 });
  if (pool) {
    await pool.query("INSERT INTO simba_handoffs (id,user_key,target,task,status) VALUES ($1,$2,$3,$4,'pending')", [h.id, userKey, h.target, h.task]);
    // Keep the tail bounded per user.
    await pool.query(
      `DELETE FROM simba_handoffs WHERE user_key=$1 AND id NOT IN (
         SELECT id FROM simba_handoffs WHERE user_key=$1 ORDER BY created_at DESC LIMIT $2)`,
      [userKey, KEEP]
    );
  } else {
    if (!mem.has(userKey)) mem.set(userKey, new Map());
    const m = mem.get(userKey);
    m.set(h.id, h);
    if (m.size > KEEP) m.delete(m.keys().next().value);
  }
  return pub(h);
}

export async function getHandoff(userKey, id) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_handoffs WHERE user_key=$1 AND id=$2", [userKey, id]);
    return r.rows[0] ? pub(r.rows[0]) : null;
  }
  const h = mem.get(userKey)?.get(id);
  return h ? pub(h) : null;
}

// Atomically claim the newest fresh pending task (so two Excel windows can't
// both run it). Returns the claimed handoff, or null when there's nothing.
export async function claimNextHandoff(userKey, target = "excel") {
  await ensureReady();
  if (pool) {
    const r = await pool.query(
      `UPDATE simba_handoffs SET status='running', updated_at=now()
       WHERE id = (
         SELECT id FROM simba_handoffs
         WHERE user_key=$1 AND target=$2 AND status='pending' AND created_at > $3
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [userKey, target, freshCutoff()]
    );
    return r.rows[0] ? pub(r.rows[0]) : null;
  }
  const cutoff = freshCutoff();
  const cands = [...(mem.get(userKey)?.values() || [])]
    .filter((h) => h.target === target && h.status === "pending" && h.created_at > cutoff)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (!cands.length) return null;
  cands[0].status = "running";
  cands[0].updated_at = new Date().toISOString();
  return pub(cands[0]);
}

export async function completeHandoff(userKey, id, { status, result }) {
  await ensureReady();
  const st = ["done", "error"].includes(status) ? status : "done";
  const res = String(result || "").slice(0, 4000);
  if (pool) await pool.query("UPDATE simba_handoffs SET status=$3, result=$4, updated_at=now() WHERE user_key=$1 AND id=$2 AND status='running'", [userKey, id, st, res]);
  else {
    const h = mem.get(userKey)?.get(id);
    if (h && h.status === "running") { h.status = st; h.result = res; h.updated_at = new Date().toISOString(); }
  }
}
