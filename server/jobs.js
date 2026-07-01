/*
 * Scheduled-job store for Simba's server-side agent.
 *
 * A "job" is a recurring instruction Simba runs on its own — e.g. "every Monday
 * 08:00, refresh the summary sheet and add today's totals" — against a workbook
 * in the user's OneDrive/SharePoint, edited server-side via Microsoft Graph (no
 * Excel window needed). Jobs are keyed to the Microsoft identity (tid:oid).
 *
 * Uses managed Postgres when DATABASE_URL is set; falls back to an in-process
 * Map otherwise (fine for dev, wiped on restart — set DATABASE_URL in prod).
 */
import { getPool, usingPostgres } from "./db.js";
import { randomUUID } from "node:crypto";

export { usingPostgres };

const MAX_JOBS_PER_USER = 25;
const MAX_PROMPT_LEN = 4000;
const MAX_RESULT_LEN = 4000;

let pool = null;
let ready = null;
const mem = new Map(); // fallback: id -> job

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_jobs (
       id          TEXT PRIMARY KEY,
       user_key    TEXT NOT NULL,
       name        TEXT NOT NULL,
       prompt      TEXT NOT NULL,
       schedule    JSONB NOT NULL,
       target      JSONB NOT NULL,
       enabled     BOOLEAN NOT NULL DEFAULT true,
       next_run    BIGINT,
       last_run    BIGINT,
       last_status TEXT,
       last_result TEXT,
       created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_jobs_due ON simba_jobs (enabled, next_run)");
}

function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] jobs store init failed:", e.message); pool = null; });
  return ready;
}

/* ---- Schedule model + next-run computation -------------------------------
 * schedule = {
 *   freq: "daily" | "weekdays" | "weekly" | "monthly" | "once",
 *   time: "HH:MM",          // local wall-clock time
 *   weekday: 0-6,           // for "weekly" (0 = Sunday)
 *   monthday: 1-31,         // for "monthly" (clamped to month length)
 *   onDate: "YYYY-MM-DD",   // for "once"
 *   tzOffset: number        // minutes, from JS getTimezoneOffset() (UTC+2 => -120)
 * }
 * All times are interpreted in the user's timezone via tzOffset, then converted
 * to a UTC epoch so the server can compare regardless of where it runs.
 */
const DAY_MS = 86_400_000;

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  if (!m) return [9, 0];
  return [Math.min(23, +m[1]), Math.min(59, +m[2])];
}

function daysInMonth(y, mIdx) { return new Date(Date.UTC(y, mIdx + 1, 0)).getUTCDate(); }

// The UTC epoch (ms) for a given local calendar day (Y, mIdx, D) at HH:MM.
function utcForLocalDay(y, mIdx, d, hh, mm, offset) {
  return Date.UTC(y, mIdx, d, hh, mm) + offset * 60_000;
}

export function computeNextRun(schedule, fromMs = Date.now()) {
  if (!schedule || typeof schedule !== "object") return null;
  const offset = Number.isFinite(schedule.tzOffset) ? schedule.tzOffset : 0;
  const [hh, mm] = parseTime(schedule.time);

  if (schedule.freq === "once") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(schedule.onDate || ""));
    if (!m) return null;
    const cand = utcForLocalDay(+m[1], +m[2] - 1, +m[3], hh, mm, offset);
    return cand > fromMs ? cand : null;
  }

  // Walk forward day-by-day in the user's local calendar.
  const localNow = new Date(fromMs - offset * 60_000); // shift so UTC getters read local wall time
  for (let i = 0; i <= 400; i++) {
    const y = localNow.getUTCFullYear();
    const mIdx = localNow.getUTCMonth();
    const d = localNow.getUTCDate() + i;
    const probe = new Date(Date.UTC(y, mIdx, d)); // normalizes overflow
    const wy = probe.getUTCFullYear(), wm = probe.getUTCMonth(), wd = probe.getUTCDate();
    const weekday = probe.getUTCDay();

    let matches = false;
    if (schedule.freq === "daily") matches = true;
    else if (schedule.freq === "weekdays") matches = weekday >= 1 && weekday <= 5;
    else if (schedule.freq === "weekly") matches = weekday === (Number(schedule.weekday) || 0);
    else if (schedule.freq === "monthly") {
      const target = Math.min(Math.max(1, Number(schedule.monthday) || 1), daysInMonth(wy, wm));
      matches = wd === target;
    }
    if (!matches) continue;

    const cand = utcForLocalDay(wy, wm, wd, hh, mm, offset);
    if (cand > fromMs) return cand;
  }
  return null;
}

function sanitizeSchedule(s) {
  const freq = ["daily", "weekdays", "weekly", "monthly", "once"].includes(s?.freq) ? s.freq : "daily";
  const out = { freq, time: /^(\d{1,2}):(\d{2})$/.test(String(s?.time)) ? s.time : "09:00", tzOffset: Number.isFinite(s?.tzOffset) ? s.tzOffset : 0 };
  if (freq === "weekly") out.weekday = Math.min(6, Math.max(0, Number(s?.weekday) || 0));
  if (freq === "monthly") out.monthday = Math.min(31, Math.max(1, Number(s?.monthday) || 1));
  if (freq === "once") out.onDate = /^\d{4}-\d{2}-\d{2}$/.test(String(s?.onDate)) ? s.onDate : null;
  return out;
}

function sanitizeTarget(t) {
  return {
    itemId: String(t?.itemId || "").slice(0, 400),
    driveId: String(t?.driveId || "").slice(0, 400),
    fileName: String(t?.fileName || "").slice(0, 300),
    notify: t?.notify !== false,                       // email a summary after each run (default on)
    email: String(t?.email || "").slice(0, 200),       // recipient (the creator), captured at creation
  };
}

function rowToJob(r) {
  return {
    id: r.id, name: r.name, prompt: r.prompt,
    schedule: r.schedule, target: r.target, enabled: r.enabled,
    nextRun: r.next_run != null ? Number(r.next_run) : null,
    lastRun: r.last_run != null ? Number(r.last_run) : null,
    lastStatus: r.last_status || null, lastResult: r.last_result || null,
  };
}

/* ---- CRUD ---------------------------------------------------------------- */

export async function listJobs(userKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_jobs WHERE user_key = $1 ORDER BY created_at DESC LIMIT $2", [userKey, MAX_JOBS_PER_USER]);
    return r.rows.map(rowToJob);
  }
  return [...mem.values()].filter((j) => j.userKey === userKey).map(rowToJob);
}

export async function createJob(userKey, { name, prompt, schedule, target }) {
  await ensureReady();
  const existing = await listJobs(userKey);
  if (existing.length >= MAX_JOBS_PER_USER) throw Object.assign(new Error("Max antal scheman nått."), { status: 400 });
  const id = randomUUID();
  const sched = sanitizeSchedule(schedule);
  const job = {
    id, user_key: userKey,
    name: String(name || "Schema").slice(0, 200),
    prompt: String(prompt || "").slice(0, MAX_PROMPT_LEN),
    schedule: sched, target: sanitizeTarget(target),
    enabled: true,
    next_run: computeNextRun(sched), last_run: null, last_status: null, last_result: null,
  };
  if (!job.prompt) throw Object.assign(new Error("Schemat saknar en instruktion."), { status: 400 });
  if (!job.target.itemId) throw Object.assign(new Error("Schemat saknar en målfil."), { status: 400 });
  if (pool) {
    await pool.query(
      `INSERT INTO simba_jobs (id, user_key, name, prompt, schedule, target, enabled, next_run)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,true,$7)`,
      [id, userKey, job.name, job.prompt, JSON.stringify(sched), JSON.stringify(job.target), job.next_run]
    );
  } else {
    mem.set(id, job);
  }
  return rowToJob(job);
}

export async function updateJob(userKey, id, patch) {
  await ensureReady();
  const job = await getJobOwned(userKey, id);
  if (!job) return null;
  const next = { ...job };
  if (typeof patch.name === "string") next.name = patch.name.slice(0, 200);
  if (typeof patch.prompt === "string") next.prompt = patch.prompt.slice(0, MAX_PROMPT_LEN);
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.schedule) next.schedule = sanitizeSchedule(patch.schedule);
  if (patch.target) next.target = sanitizeTarget(patch.target);
  next.nextRun = next.enabled ? computeNextRun(next.schedule) : null;
  if (pool) {
    await pool.query(
      `UPDATE simba_jobs SET name=$3, prompt=$4, schedule=$5::jsonb, target=$6::jsonb, enabled=$7, next_run=$8 WHERE user_key=$1 AND id=$2`,
      [userKey, id, next.name, next.prompt, JSON.stringify(next.schedule), JSON.stringify(next.target), next.enabled, next.nextRun]
    );
  } else {
    mem.set(id, { ...mem.get(id), name: next.name, prompt: next.prompt, schedule: next.schedule, target: next.target, enabled: next.enabled, next_run: next.nextRun });
  }
  return await getJobOwned(userKey, id);
}

export async function deleteJob(userKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_jobs WHERE user_key = $1 AND id = $2", [userKey, id]);
  else if (mem.get(id)?.user_key === userKey) mem.delete(id);
}

export async function getJobOwned(userKey, id) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_jobs WHERE user_key = $1 AND id = $2", [userKey, id]);
    return r.rows[0] ? rowToJob(r.rows[0]) : null;
  }
  const j = mem.get(id);
  return j && j.user_key === userKey ? rowToJob(j) : null;
}

/* ---- Scheduler-facing helpers ------------------------------------------- */

// Jobs whose next_run is due (and enabled). Includes user_key so the runner
// can act as that user via Graph.
export async function dueJobs(nowMs = Date.now()) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_jobs WHERE enabled = true AND next_run IS NOT NULL AND next_run <= $1 LIMIT 20", [nowMs]);
    return r.rows.map((row) => ({ ...rowToJob(row), userKey: row.user_key }));
  }
  return [...mem.values()]
    .filter((j) => j.enabled && j.next_run != null && j.next_run <= nowMs)
    .map((j) => ({ ...rowToJob(j), userKey: j.user_key }));
}

// Atomically claim a due job by pushing its next_run to a lease time, so a second
// instance won't run it too. Returns true if THIS caller won the claim.
export async function claimJob(id, leaseUntilMs, nowMs = Date.now()) {
  await ensureReady();
  if (pool) {
    const r = await pool.query(
      "UPDATE simba_jobs SET next_run = $2 WHERE id = $1 AND enabled = true AND next_run IS NOT NULL AND next_run <= $3 RETURNING id",
      [id, leaseUntilMs, nowMs]
    );
    return r.rowCount > 0;
  }
  const j = mem.get(id);
  if (j && j.enabled && j.next_run != null && j.next_run <= nowMs) { j.next_run = leaseUntilMs; return true; }
  return false;
}

// Record the outcome of a run and schedule the next occurrence.
export async function recordRun(id, { status, result, ranAtMs = Date.now() }) {
  await ensureReady();
  const res = String(result || "").slice(0, MAX_RESULT_LEN);
  if (pool) {
    const r = await pool.query("SELECT schedule FROM simba_jobs WHERE id = $1", [id]);
    const sched = r.rows[0]?.schedule;
    const nextRun = sched ? computeNextRun(sched, ranAtMs) : null;
    await pool.query(
      "UPDATE simba_jobs SET last_run=$2, last_status=$3, last_result=$4, next_run=$5 WHERE id=$1",
      [id, ranAtMs, status, res, nextRun]
    );
  } else {
    const j = mem.get(id);
    if (j) { j.last_run = ranAtMs; j.last_status = status; j.last_result = res; j.next_run = computeNextRun(j.schedule, ranAtMs); }
  }
}
