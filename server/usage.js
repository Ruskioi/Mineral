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
import pg from "pg";

export const usingPostgres = Boolean(process.env.DATABASE_URL);

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

function makeSsl() {
  if (process.env.PGSSL_DISABLE) return false;
  if (process.env.PGSSL_CA) return { ca: process.env.PGSSL_CA, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

async function init() {
  if (!usingPostgres) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: makeSsl(), max: 5 });
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
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] usage init failed:", e.message); pool = null; });
  return ready;
}

function today() { return new Date().toISOString().slice(0, 10); }

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
  const weekStart = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);

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
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const r = byDay.get(d);
    summary.series.push({ day: d, turns: Number(r?.turns || 0), cost: Number(r?.cost || 0) });
  }
  return summary;
}
