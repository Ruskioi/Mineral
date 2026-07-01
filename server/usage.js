/*
 * Per-user usage & estimated spend accounting for the profile view.
 *
 * After each chat turn we record the model's token usage (from the Anthropic
 * `usage` block) keyed to the Microsoft identity, and estimate the cost from
 * published per-model pricing. The profile then shows turns, tokens, and an
 * ESTIMATED cost — Simba bills nothing itself; this is a transparency/cost-guard
 * view over the org's Anthropic spend, not an invoice.
 *
 * Postgres when DATABASE_URL is set; in-memory fallback (per instance) otherwise.
 */
import { getPool, usingPostgres } from "./db.js";

export { usingPostgres };

// Published list prices, USD per 1,000,000 tokens (input / output). Cache reads
// bill ~0.1x the input rate; 5-minute cache writes ~1.25x. Matched by substring
// against the model id the API actually served.
const PRICING = [
  { match: /opus/i, in: 5, out: 25 },
  { match: /haiku/i, in: 1, out: 5 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /fable|mythos/i, in: 10, out: 50 },
];
const DEFAULT_PRICE = { in: 5, out: 25 }; // opus-tier default

function priceFor(model) {
  return PRICING.find((p) => p.match.test(String(model || ""))) || DEFAULT_PRICE;
}

// Estimated USD cost for one turn's usage against a model's list price.
export function estimateCost(model, usage = {}) {
  const p = priceFor(model);
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens || 0);
  const cost =
    (inTok * p.in + outTok * p.out + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1_000_000;
  return { cost, inTok, outTok, cacheRead, cacheWrite };
}

let pool = null;
let ready = null;
const mem = new Map(); // userKey -> Map(day -> row)
const memModels = new Map(); // userKey -> Map(model -> {turns,in_tokens,out_tokens,cost})
const memHours = new Map();  // userKey -> number[24] (turns per hour of day)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_usage (
       user_key   TEXT NOT NULL,
       day        DATE NOT NULL,
       turns      INTEGER NOT NULL DEFAULT 0,
       in_tokens  BIGINT  NOT NULL DEFAULT 0,
       out_tokens BIGINT  NOT NULL DEFAULT 0,
       cache_read BIGINT  NOT NULL DEFAULT 0,
       cache_write BIGINT NOT NULL DEFAULT 0,
       cost       DOUBLE PRECISION NOT NULL DEFAULT 0,
       PRIMARY KEY (user_key, day)
     )`
  );
  // Per-model totals (favorite model + Models tab).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_usage_models (
       user_key   TEXT NOT NULL,
       model      TEXT NOT NULL,
       turns      INTEGER NOT NULL DEFAULT 0,
       in_tokens  BIGINT  NOT NULL DEFAULT 0,
       out_tokens BIGINT  NOT NULL DEFAULT 0,
       cost       DOUBLE PRECISION NOT NULL DEFAULT 0,
       PRIMARY KEY (user_key, model)
     )`
  );
  // Per-hour-of-day totals (peak hour).
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_usage_hours (
       user_key TEXT NOT NULL,
       hour     INTEGER NOT NULL,
       turns    INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY (user_key, hour)
     )`
  );
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] usage init failed:", e.message); pool = null; });
  return ready;
}

// Bucket days/hours in the org's local timezone, not UTC — otherwise evening
// turns count toward the wrong day and "peak hour" is shifted for Swedish users.
const TZ = process.env.SIMBA_TZ || "Europe/Stockholm";
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });
function localDay(d = new Date()) { return dayFmt.format(d); }
function today() { return localDay(); }

// Record one turn's usage for a user. Best-effort — never throws to the caller.
export async function recordUsage(userKey, model, usage) {
  if (!userKey) return;
  try {
    await ensureReady();
    const { cost, inTok, outTok, cacheRead, cacheWrite } = estimateCost(model, usage);
    const day = today();
    if (pool) {
      await pool.query(
        `INSERT INTO simba_usage (user_key, day, turns, in_tokens, out_tokens, cache_read, cache_write, cost)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7)
         ON CONFLICT (user_key, day) DO UPDATE SET
           turns = simba_usage.turns + 1,
           in_tokens = simba_usage.in_tokens + $3,
           out_tokens = simba_usage.out_tokens + $4,
           cache_read = simba_usage.cache_read + $5,
           cache_write = simba_usage.cache_write + $6,
           cost = simba_usage.cost + $7`,
        [userKey, day, inTok, outTok, cacheRead, cacheWrite, cost]
      );
    } else {
      if (!mem.has(userKey)) mem.set(userKey, new Map());
      const days = mem.get(userKey);
      const r = days.get(day) || { day, turns: 0, in_tokens: 0, out_tokens: 0, cache_read: 0, cache_write: 0, cost: 0 };
      r.turns += 1; r.in_tokens += inTok; r.out_tokens += outTok;
      r.cache_read += cacheRead; r.cache_write += cacheWrite; r.cost += cost;
      days.set(day, r);
      if (days.size > 400) days.delete([...days.keys()].sort()[0]); // cap history
    }
    // Per-model + per-hour aggregates (for favorite model + peak hour).
    const mdl = String(model || "").slice(0, 60) || "okänd";
    const hour = Number(hourFmt.format(new Date())) % 24;
    if (pool) {
      await pool.query(
        `INSERT INTO simba_usage_models (user_key, model, turns, in_tokens, out_tokens, cost)
         VALUES ($1,$2,1,$3,$4,$5)
         ON CONFLICT (user_key, model) DO UPDATE SET
           turns = simba_usage_models.turns + 1,
           in_tokens = simba_usage_models.in_tokens + $3,
           out_tokens = simba_usage_models.out_tokens + $4,
           cost = simba_usage_models.cost + $5`,
        [userKey, mdl, inTok, outTok, cost]
      );
      await pool.query(
        `INSERT INTO simba_usage_hours (user_key, hour, turns) VALUES ($1,$2,1)
         ON CONFLICT (user_key, hour) DO UPDATE SET turns = simba_usage_hours.turns + 1`,
        [userKey, hour]
      );
    } else {
      if (!memModels.has(userKey)) memModels.set(userKey, new Map());
      const mm = memModels.get(userKey);
      const mr = mm.get(mdl) || { model: mdl, turns: 0, in_tokens: 0, out_tokens: 0, cost: 0 };
      mr.turns += 1; mr.in_tokens += inTok; mr.out_tokens += outTok; mr.cost += cost;
      mm.set(mdl, mr);
      if (!memHours.has(userKey)) memHours.set(userKey, new Array(24).fill(0));
      memHours.get(userKey)[hour] += 1;
    }
  } catch (e) { console.error("[Simba] recordUsage failed:", e?.message || e); }
}

function blankRow(day) { return { day, turns: 0, in_tokens: 0, out_tokens: 0, cache_read: 0, cache_write: 0, cost: 0 }; }
function addInto(acc, r) {
  acc.turns += Number(r.turns || 0);
  acc.in_tokens += Number(r.in_tokens || 0);
  acc.out_tokens += Number(r.out_tokens || 0);
  acc.cache_read += Number(r.cache_read || 0);
  acc.cache_write += Number(r.cache_write || 0);
  acc.cost += Number(r.cost || 0);
  return acc;
}

async function allRows(userKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, turns, in_tokens, out_tokens, cache_read, cache_write, cost FROM simba_usage WHERE user_key=$1 ORDER BY day DESC LIMIT 400", [userKey]);
    return r.rows;
  }
  return [...(mem.get(userKey)?.values() || [])].sort((a, b) => (a.day < b.day ? 1 : -1));
}

// A summary for the profile: today, last 7 days (with a per-day series), this
// calendar month, and all-time — each with turns, tokens, and estimated cost.
export async function getUsage(userKey) {
  const rows = await allRows(userKey);
  const day = today();
  const month = day.slice(0, 7);
  const weekStart = localDay(new Date(Date.now() - 6 * 86400_000));

  const summary = {
    today: blankRow("today"), week: blankRow("week"), month: blankRow("month"), all: blankRow("all"),
    series: [],
  };
  const byDay = new Map(rows.map((r) => [r.day, r]));
  for (const r of rows) {
    addInto(summary.all, r);
    if (r.day === day) addInto(summary.today, r);
    if (r.day >= weekStart) addInto(summary.week, r);
    if (String(r.day).startsWith(month)) addInto(summary.month, r);
  }
  // 7-day series (oldest → newest) for a small bar chart, zero-filled.
  for (let i = 6; i >= 0; i--) {
    const d = localDay(new Date(Date.now() - i * 86400_000));
    const r = byDay.get(d);
    summary.series.push({ day: d, turns: Number(r?.turns || 0), cost: Number(r?.cost || 0) });
  }
  return summary;
}

async function modelRows(userKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT model, turns, in_tokens, out_tokens, cost FROM simba_usage_models WHERE user_key=$1 ORDER BY turns DESC", [userKey]);
    return r.rows;
  }
  return [...(memModels.get(userKey)?.values() || [])].sort((a, b) => b.turns - a.turns);
}
async function hourRows(userKey) {
  await ensureReady();
  const hours = new Array(24).fill(0);
  if (pool) {
    const r = await pool.query("SELECT hour, turns FROM simba_usage_hours WHERE user_key=$1", [userKey]);
    for (const row of r.rows) hours[Number(row.hour)] = Number(row.turns);
  } else {
    (memHours.get(userKey) || []).forEach((n, i) => { hours[i] = Number(n || 0); });
  }
  return hours;
}

// Rich stats for the home dashboard: a full daily activity series (for the
// heatmap + range-scoped totals), per-model breakdown, and per-hour histogram.
// Range-scoping of the daily numbers is done on the client from `series`.
export async function getStats(userKey) {
  const [rows, mRows, hours] = await Promise.all([allRows(userKey), modelRows(userKey), hourRows(userKey)]);
  const tokensOf = (r) => Number(r.in_tokens || 0) + Number(r.out_tokens || 0) + Number(r.cache_read || 0) + Number(r.cache_write || 0);
  const series = rows
    .map((r) => ({ day: r.day, messages: Number(r.turns || 0), tokens: tokensOf(r), cost: Number(r.cost || 0) }))
    .sort((a, b) => (a.day < b.day ? -1 : 1)); // oldest → newest
  const models = mRows.map((m) => ({
    model: m.model, messages: Number(m.turns || 0),
    tokens: Number(m.in_tokens || 0) + Number(m.out_tokens || 0), cost: Number(m.cost || 0),
  }));
  return { series, models, hours };
}
