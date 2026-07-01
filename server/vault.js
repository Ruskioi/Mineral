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
import { getPool, usingPostgres } from "./db.js";
import { randomUUID } from "node:crypto";
import { embed, embedOne, cosine, vectorEnabled, chunkText, rerank, rerankEnabled } from "./embeddings.js";

export { usingPostgres };
export { vectorEnabled };

const MAX_ENTRIES = 5000;
const MAX_CONTENT = 20000;     // generous — entries can hold extracted document text
const MAX_TITLE = 200;
const MAX_TOPIC = 80;
const MAX_FILE_B64 = 12 * 1024 * 1024; // ~9MB binary cap per attachment

let pool = null;
let ready = null;
const mem = new Map(); // orgKey -> Map(id -> entry)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
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
  // Additive columns (safe on existing installs): attachments + embeddings.
  for (const col of [
    "file_name TEXT", "file_type TEXT", "file_data TEXT", "embedding JSONB",
    "chunks JSONB", // [{text, embedding}] — passage-level vectors for fine-grained retrieval
  ]) await pool.query(`ALTER TABLE simba_vault ADD COLUMN IF NOT EXISTS ${col}`);
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
// Public shape returned by the API — no heavy fields (file bytes, embedding).
function publicEntry(r) {
  return {
    id: r.id, topic: r.topic, title: r.title, content: r.content, tags: r.tags || [],
    author: r.author || "", updated_at: r.updated_at,
    file: r.file_name ? { name: r.file_name, type: r.file_type } : null,
  };
}
function searchableText(e) { return [e.title, e.title, e.topic, (e.tags || []).join(" "), e.content].filter(Boolean).join("\n"); }

// Raw rows incl. embedding (for scoring); excludes file bytes for size.
// Retrieval runs on EVERY chat turn, and these rows carry all passage vectors —
// so cache per org for a short TTL and invalidate on writes. (On multi-instance
// deployments another instance's write can be visible up to TTL late; fine for
// a knowledge base where reads vastly dominate.)
const rawCache = new Map(); // orgKey -> { at, rows }
const RAW_TTL_MS = 60_000;
function invalidateOrg(orgKey) { rawCache.delete(orgKey); }
async function listRaw(orgKey) {
  await ensureReady();
  const hit = rawCache.get(orgKey);
  if (hit && Date.now() - hit.at < RAW_TTL_MS) return hit.rows;
  let rows;
  if (pool) {
    const r = await pool.query(
      "SELECT id, org_key, topic, title, content, tags, author, updated_at, file_name, file_type, embedding, chunks FROM simba_vault WHERE org_key = $1 ORDER BY topic, title LIMIT $2",
      [orgKey, MAX_ENTRIES]
    );
    rows = r.rows;
  } else {
    rows = [...(mem.get(orgKey)?.values() || [])].slice().sort((a, b) => (a.topic + a.title).localeCompare(b.topic + b.title));
  }
  rawCache.set(orgKey, { at: Date.now(), rows });
  if (rawCache.size > 200) rawCache.delete(rawCache.keys().next().value); // bound orgs held
  return rows;
}

export async function listVault(orgKey) {
  return (await listRaw(orgKey)).map(publicEntry);
}

export async function getEntry(orgKey, id) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT id, topic, title, content, tags, author, updated_at, file_name, file_type FROM simba_vault WHERE org_key = $1 AND id = $2", [orgKey, id]);
    return r.rows[0] ? publicEntry(r.rows[0]) : null;
  }
  const e = mem.get(orgKey)?.get(id);
  return e ? publicEntry(e) : null;
}

// Return an attached file's bytes (for opening/reading).
export async function getFile(orgKey, id) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT file_name, file_type, file_data FROM simba_vault WHERE org_key = $1 AND id = $2", [orgKey, id]);
    const row = r.rows[0];
    return row && row.file_data ? { name: row.file_name, type: row.file_type, data: row.file_data } : null;
  }
  const e = mem.get(orgKey)?.get(id);
  return e && e.file_data ? { name: e.file_name, type: e.file_type, data: e.file_data } : null;
}

// Fold a sanitized attachment + extracted text into the stored fields.
function applyFile(target, file) {
  if (!file) return "";
  target.file_name = clean(file.name, 300) || "fil";
  target.file_type = clean(file.type, 120);
  target.file_data = (typeof file.data === "string" && file.data.length <= MAX_FILE_B64) ? file.data : null;
  return file.text ? `\n\n[Ur filen ${target.file_name}]\n${String(file.text)}` : "";
}

// Compute both a coarse entry-level vector (kept for back-compat / topic match)
// and fine-grained passage vectors so retrieval can hit the exact relevant part
// of a long document. One batched embed call covers the whole entry.
async function computeVectors(entry) {
  if (!vectorEnabled) return { embedding: null, chunks: null };
  try {
    const titleCtx = [entry.topic, entry.title].filter(Boolean).join(" — ");
    const passages = chunkText(entry.content || "");
    // Prefix each passage with the title/topic so an out-of-context chunk still
    // embeds against the right subject.
    const texts = passages.map((p) => (titleCtx ? `${titleCtx}\n${p}` : p));
    const all = await embed([searchableText(entry), ...texts], "document");
    if (!all || !all.length) return { embedding: null, chunks: null };
    const embedding = all[0] || null;
    const chunks = passages
      .map((text, i) => ({ text, embedding: all[i + 1] || null }))
      .filter((c) => Array.isArray(c.embedding));
    return { embedding, chunks: chunks.length ? chunks : null };
  } catch (e) {
    console.error("[Simba] vault embed failed:", e?.message || e);
    return { embedding: null, chunks: null };
  }
}

export async function createEntry(orgKey, { topic, title, content, tags, author, file }) {
  await ensureReady();
  const entry = {
    id: randomUUID(), org_key: orgKey,
    topic: clean(topic, MAX_TOPIC) || "Allmänt",
    title: clean(title, MAX_TITLE),
    content: clean(content, MAX_CONTENT),
    tags: cleanTags(tags), author: clean(author, 200),
    file_name: null, file_type: null, file_data: null, embedding: null, chunks: null,
    updated_at: new Date().toISOString(),
  };
  if (!entry.title) throw Object.assign(new Error("Posten saknar titel."), { status: 400 });
  const extracted = applyFile(entry, file);
  if (extracted) entry.content = (entry.content + extracted).slice(0, MAX_CONTENT);
  const vec = await computeVectors(entry);
  entry.embedding = vec.embedding; entry.chunks = vec.chunks;
  if (pool) {
    await pool.query(
      `INSERT INTO simba_vault (id, org_key, topic, title, content, tags, author, file_name, file_type, file_data, embedding, chunks)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
      [entry.id, orgKey, entry.topic, entry.title, entry.content, JSON.stringify(entry.tags), entry.author, entry.file_name, entry.file_type, entry.file_data, entry.embedding ? JSON.stringify(entry.embedding) : null, entry.chunks ? JSON.stringify(entry.chunks) : null]
    );
  } else {
    if (!mem.has(orgKey)) mem.set(orgKey, new Map());
    mem.get(orgKey).set(entry.id, entry);
  }
  invalidateOrg(orgKey);
  return publicEntry(entry);
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
    file_name: null, file_type: null, file_data: null,
  };
  if (!next.title) throw Object.assign(new Error("Posten saknar titel."), { status: 400 });
  if (patch.file) {
    const extracted = applyFile(next, patch.file);
    if (extracted) next.content = (next.content + extracted).slice(0, MAX_CONTENT);
  } else if (cur.file) { // keep existing attachment unless explicitly replaced
    const f = await getFile(orgKey, id);
    if (f) { next.file_name = f.name; next.file_type = f.type; next.file_data = f.data; }
  }
  // Re-embed only when the searchable text actually changed — a tag edit or
  // rename shouldn't trigger a full multi-chunk embedding round-trip.
  const textChanged = next.content !== cur.content || next.title !== cur.title || next.topic !== cur.topic;
  if (textChanged) {
    const vec = await computeVectors(next);
    next.embedding = vec.embedding; next.chunks = vec.chunks;
  } else {
    const prev = (await listRaw(orgKey)).find((e) => e.id === id);
    next.embedding = prev?.embedding ?? null; next.chunks = prev?.chunks ?? null;
  }
  if (pool) {
    await pool.query(
      "UPDATE simba_vault SET topic=$3, title=$4, content=$5, tags=$6::jsonb, file_name=$7, file_type=$8, file_data=$9, embedding=$10::jsonb, chunks=$11::jsonb, updated_at=now() WHERE org_key=$1 AND id=$2",
      [orgKey, id, next.topic, next.title, next.content, JSON.stringify(next.tags), next.file_name, next.file_type, next.file_data, next.embedding ? JSON.stringify(next.embedding) : null, next.chunks ? JSON.stringify(next.chunks) : null]
    );
  } else {
    const e = mem.get(orgKey)?.get(id);
    if (e) Object.assign(e, next, { updated_at: new Date().toISOString() });
  }
  invalidateOrg(orgKey);
  return await getEntry(orgKey, id);
}

export async function deleteEntry(orgKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_vault WHERE org_key = $1 AND id = $2", [orgKey, id]);
  else mem.get(orgKey)?.delete(id);
  invalidateOrg(orgKey);
}

// A compact digest of the whole vault for analysis (titles + snippets).
export async function digest(orgKey, maxChars = 18000) {
  const all = await listRaw(orgKey);
  const lines = [];
  let used = 0;
  for (const e of all) {
    const line = `- [${e.topic}] ${e.title}${e.file_name ? ` (bilaga: ${e.file_name})` : ""}: ${String(e.content || "").replace(/\s+/g, " ").slice(0, 240)}`;
    if (used + line.length > maxChars) { lines.push(`… (+${all.length - lines.length} fler poster)`); break; }
    lines.push(line); used += line.length;
  }
  return { count: all.length, topics: [...new Set(all.map((e) => e.topic))], text: lines.join("\n") };
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

// Core ranked retrieval. Returns scored candidates with the best-matching passage
// for each entry, so callers can both list results and ground answers in the exact
// relevant snippet. Pipeline: keyword + passage-level cosine (hybrid) → optional
// cross-encoder rerank for precise final ordering.
async function searchRanked(orgKey, query, limit = 8) {
  const raw = await listRaw(orgKey);
  const ts = terms(query);
  if (!query || !query.trim()) {
    return raw.slice(0, limit).map((e) => ({ e, snippet: String(e.content || "").slice(0, 1200), sim: 0, kw: 0 }));
  }

  // Semantic query vector (Voyage) when available; blended with keyword score so
  // exact term matches still rank well — a hybrid retriever.
  let qvec = null;
  if (vectorEnabled) { try { qvec = await embedOne(query, "query"); } catch { /* fall back to keyword */ } }

  const ranked = raw.map((e) => {
    const kw = score(e, ts);
    // Best passage: prefer the strongest chunk; fall back to the entry vector.
    let sim = 0, bestChunk = null;
    if (qvec) {
      if (Array.isArray(e.chunks)) {
        for (const c of e.chunks) {
          if (!Array.isArray(c.embedding)) continue;
          const cs = cosine(qvec, c.embedding);
          if (cs > sim) { sim = cs; bestChunk = c.text; }
        }
      }
      if (Array.isArray(e.embedding)) sim = Math.max(sim, cosine(qvec, e.embedding));
    }
    const snippet = bestChunk || String(e.content || "").slice(0, 1200);
    return { e, total: sim * 8 + kw, sim, kw, snippet };
  })
    .filter((x) => x.total > 0 || x.sim > 0.18)
    .sort((a, b) => b.total - a.total);

  // Take a generous candidate set, then let a cross-encoder rerank the actual
  // passages for the final, more precise ordering.
  let cands = ranked.slice(0, Math.max(limit * 3, 18));
  if (rerankEnabled && cands.length > 1) {
    const docs = cands.map((x) => `${x.e.title}\n${x.snippet}`.slice(0, 4000));
    const order = await rerank(query, docs, limit);
    if (order && order.length) cands = order.map((o) => cands[o.index]).filter(Boolean);
  }
  return cands.slice(0, limit);
}

export async function searchVault(orgKey, query, limit = 8) {
  return (await searchRanked(orgKey, query, limit)).map((x) => publicEntry(x.e));
}

// Build a compact context block of the most relevant entries for a turn — grounded
// on the matched passage (not just the head of the document) so the model sees the
// part that actually answers the question.
// Memoized per (org, query) for a short window: during an agent loop every tool
// round-trip re-runs retrieval for the SAME user text, which otherwise costs a
// fresh Voyage embed + rerank network round-trip each time. Also keeps the
// injected context byte-identical across loop iterations (prompt-cache friendly).
const ctxCache = new Map(); // `${orgKey} ${text}` -> { at, out }
const CTX_TTL_MS = 60_000;
export async function retrieveForContext(orgKey, text, maxChars = 4000) {
  if (!orgKey) return "";
  const key = `${orgKey} ${String(text || "").slice(0, 500)}`;
  const hit = ctxCache.get(key);
  if (hit && Date.now() - hit.at < CTX_TTL_MS) return hit.out;
  const out = await retrieveForContextUncached(orgKey, text, maxChars);
  ctxCache.set(key, { at: Date.now(), out });
  if (ctxCache.size > 300) ctxCache.delete(ctxCache.keys().next().value);
  return out;
}
async function retrieveForContextUncached(orgKey, text, maxChars) {
  const hits = await searchRanked(orgKey, text, 10);
  if (!hits.length) return "";
  const parts = [];
  let used = 0;
  for (const { e, snippet } of hits) {
    const block = `• [${e.topic}] ${e.title}: ${snippet}`.slice(0, 1400);
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}
