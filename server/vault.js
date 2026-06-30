/*
 * Simba's shared "mind" — an organization-wide knowledge vault.
 *
 * Unlike per-user memory (store.js), the vault is shared by EVERY session and
 * user in the same Microsoft tenant: a structured set of entries (topic + title
 * + content + tags) describing the company. Simba retrieves the most relevant
 * entries on each turn and grounds its answers in them, so it carries the same
 * company knowledge everywhere. It's also the corpus you'd later fine-tune on.
 *
 * Org scope = the tenant id (tid). Uses Postgres when DATABASE_URL is set, with
 * an in-memory fallback for local dev.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

export const usingPostgres = Boolean(process.env.DATABASE_URL);

const MAX_ENTRIES = 5000;
const MAX_CONTENT = 8000;
const MAX_TITLE = 200;
const MAX_TOPIC = 80;

let pool = null;
let ready = null;
const mem = new Map(); // orgKey -> Map(id -> entry)

function makeSsl() {
  if (process.env.PGSSL_DISABLE) return false;
  if (process.env.PGSSL_CA) return { ca: process.env.PGSSL_CA, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

async function init() {
  if (!usingPostgres) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: makeSsl(), max: 5 });
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_vault (
       id         TEXT PRIMARY KEY,
       org_key    TEXT NOT NULL,
       topic      TEXT NOT NULL DEFAULT 'Allmänt',
       title      TEXT NOT NULL,
       content    TEXT NOT NULL DEFAULT '',
       tags       JSONB NOT NULL DEFAULT '[]'::jsonb,
       author     TEXT,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_vault_org ON simba_vault (org_key, topic)");
}

function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] vault init failed:", e.message); pool = null; });
  return ready;
}

function clean(s, max) { return String(s ?? "").trim().slice(0, max); }
function cleanTags(t) {
  const arr = Array.isArray(t) ? t : String(t || "").split(",");
  return [...new Set(arr.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}
function rowToEntry(r) {
  return { id: r.id, topic: r.topic, title: r.title, content: r.content, tags: r.tags || [], author: r.author || "", updated_at: r.updated_at };
}

export async function listVault(orgKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_vault WHERE org_key = $1 ORDER BY topic, title LIMIT $2", [orgKey, MAX_ENTRIES]);
    return r.rows.map(rowToEntry);
  }
  return [...(mem.get(orgKey)?.values() || [])].map(rowToEntry).sort((a, b) => (a.topic + a.title).localeCompare(b.topic + b.title));
}

export async function getEntry(orgKey, id) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_vault WHERE org_key = $1 AND id = $2", [orgKey, id]);
    return r.rows[0] ? rowToEntry(r.rows[0]) : null;
  }
  const e = mem.get(orgKey)?.get(id);
  return e ? rowToEntry(e) : null;
}

export async function createEntry(orgKey, { topic, title, content, tags, author }) {
  await ensureReady();
  const entry = {
    id: randomUUID(), org_key: orgKey,
    topic: clean(topic, MAX_TOPIC) || "Allmänt",
    title: clean(title, MAX_TITLE),
    content: clean(content, MAX_CONTENT),
    tags: cleanTags(tags), author: clean(author, 200),
    updated_at: new Date().toISOString(),
  };
  if (!entry.title) throw Object.assign(new Error("Posten saknar titel."), { status: 400 });
  if (pool) {
    await pool.query(
      `INSERT INTO simba_vault (id, org_key, topic, title, content, tags, author) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [entry.id, orgKey, entry.topic, entry.title, entry.content, JSON.stringify(entry.tags), entry.author]
    );
  } else {
    if (!mem.has(orgKey)) mem.set(orgKey, new Map());
    mem.get(orgKey).set(entry.id, entry);
  }
  return rowToEntry(entry);
}

export async function updateEntry(orgKey, id, patch) {
  await ensureReady();
  const cur = await getEntry(orgKey, id);
  if (!cur) return null;
  const next = {
    topic: patch.topic != null ? clean(patch.topic, MAX_TOPIC) || "Allmänt" : cur.topic,
    title: patch.title != null ? clean(patch.title, MAX_TITLE) : cur.title,
    content: patch.content != null ? clean(patch.content, MAX_CONTENT) : cur.content,
    tags: patch.tags != null ? cleanTags(patch.tags) : cur.tags,
  };
  if (!next.title) throw Object.assign(new Error("Posten saknar titel."), { status: 400 });
  if (pool) {
    await pool.query(
      "UPDATE simba_vault SET topic=$3, title=$4, content=$5, tags=$6::jsonb, updated_at=now() WHERE org_key=$1 AND id=$2",
      [orgKey, id, next.topic, next.title, next.content, JSON.stringify(next.tags)]
    );
  } else {
    const e = mem.get(orgKey)?.get(id);
    if (e) Object.assign(e, next, { updated_at: new Date().toISOString() });
  }
  return await getEntry(orgKey, id);
}

export async function deleteEntry(orgKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_vault WHERE org_key = $1 AND id = $2", [orgKey, id]);
  else mem.get(orgKey)?.delete(id);
}

/* ---- Retrieval ----------------------------------------------------------
 * Keyword scoring (no embeddings dependency): rank entries by how many query
 * terms they contain, weighting title/topic/tags above body text. Good enough
 * to surface the right company facts; swap in vector search later if needed.
 */
function score(entry, terms) {
  if (!terms.length) return 0;
  const title = (entry.title || "").toLowerCase();
  const topic = (entry.topic || "").toLowerCase();
  const tags = (entry.tags || []).join(" ").toLowerCase();
  const body = (entry.content || "").toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (title.includes(t)) s += 5;
    if (topic.includes(t)) s += 3;
    if (tags.includes(t)) s += 3;
    if (body.includes(t)) s += 1;
  }
  return s;
}
function terms(query) {
  return [...new Set(String(query || "").toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])];
}

export async function searchVault(orgKey, query, limit = 8) {
  const all = await listVault(orgKey);
  const ts = terms(query);
  if (!ts.length) return all.slice(0, limit);
  return all.map((e) => ({ e, s: score(e, ts) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.e);
}

// Build a compact context block of the most relevant entries for a turn.
export async function retrieveForContext(orgKey, text, maxChars = 4000) {
  if (!orgKey) return "";
  const hits = await searchVault(orgKey, text, 10);
  if (!hits.length) return "";
  const parts = [];
  let used = 0;
  for (const e of hits) {
    const block = `• [${e.topic}] ${e.title}: ${e.content}`.slice(0, 1200);
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}
