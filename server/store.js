/*
 * Per-user memory store for Simba.
 *
 * Uses managed Postgres when DATABASE_URL is set (durable, cross-device).
 * Falls back to an in-process Map when it isn't — fine for local dev, but NOT
 * persistent (wiped on restart), so set DATABASE_URL in production.
 */
import pg from "pg";

const MAX_NOTES = 50;
const MAX_NOTE_LEN = 280;

export const usingPostgres = Boolean(process.env.DATABASE_URL);

let pool = null;
let ready = null;
const mem = new Map(); // fallback: userKey -> string[]

function sanitize(notes) {
  if (!Array.isArray(notes)) return [];
  const seen = new Set();
  const out = [];
  for (const n of notes) {
    const t = String(n ?? "").trim().slice(0, MAX_NOTE_LEN);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= MAX_NOTES) break;
  }
  return out;
}

async function init() {
  if (!usingPostgres) return;
  // Render/Neon/Supabase require TLS; allow self-signed chains from managed PG.
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL_DISABLE ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_memory (
       user_key  TEXT PRIMARY KEY,
       notes     JSONB NOT NULL DEFAULT '[]'::jsonb,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
}

function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] store init failed:", e.message); pool = null; });
  return ready;
}

export async function getMemory(userKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT notes FROM simba_memory WHERE user_key = $1", [userKey]);
    return sanitize(r.rows[0]?.notes || []);
  }
  return sanitize(mem.get(userKey) || []);
}

export async function setMemory(userKey, notes) {
  await ensureReady();
  const clean = sanitize(notes);
  if (pool) {
    await pool.query(
      `INSERT INTO simba_memory (user_key, notes, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_key) DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()`,
      [userKey, JSON.stringify(clean)]
    );
  } else {
    mem.set(userKey, clean);
  }
  return clean;
}
