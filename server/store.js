/*
 * Per-user memory store for Simba.
 *
 * Uses managed Postgres when DATABASE_URL is set (durable, cross-device).
 * Falls back to an in-process Map when it isn't — fine for local dev, but NOT
 * persistent (wiped on restart), so set DATABASE_URL in production.
 */
import { getPool, usingPostgres } from "./db.js";

const MAX_NOTES = 50;
const MAX_NOTE_LEN = 280;

export { usingPostgres };

const MAX_CONV_BYTES = 600_000;   // cap a stored conversation
const MAX_CONV_MESSAGES = 200;    // keep the most recent N messages
const MAX_CONV_LIST = 40;         // recent conversations returned

const MAX_WS_ITEMS = 40;          // shared workspace items per user
const MAX_WS_CONTENT = 6000;      // per item

let pool = null;
let ready = null;
const mem = new Map(); // fallback: userKey -> string[]
const convMem = new Map(); // fallback: userKey -> Map(id -> {id,title,messages,updated_at})
const wsMem = new Map();   // fallback: userKey -> Map(id -> {id,label,content,source,updated_at})

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
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_memory (
       user_key  TEXT PRIMARY KEY,
       notes     JSONB NOT NULL DEFAULT '[]'::jsonb,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_conversations (
       user_key   TEXT NOT NULL,
       id         TEXT NOT NULL,
       title      TEXT,
       messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (user_key, id)
     )`
  );
  // Per-user shared workspace: working context that syncs across the user's
  // surfaces (Excel, Outlook, web, desktop) — e.g. a table captured in Excel
  // that Simba can then use while drafting a mail in Outlook.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_workspace (
       user_key   TEXT NOT NULL,
       id         TEXT NOT NULL,
       label      TEXT NOT NULL,
       content    TEXT NOT NULL DEFAULT '',
       source     TEXT,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (user_key, id)
     )`
  );
}

// Trim a conversation to a safe size before storing.
function trimMessages(messages) {
  let msgs = Array.isArray(messages) ? messages : [];
  if (msgs.length > MAX_CONV_MESSAGES) msgs = msgs.slice(-MAX_CONV_MESSAGES);
  while (msgs.length > 2 && JSON.stringify(msgs).length > MAX_CONV_BYTES) msgs = msgs.slice(1);
  return msgs;
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

/* ---- Conversations (shared across the user's devices/surfaces) ---------- */

export async function listConversations(userKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query(
      "SELECT id, title, updated_at FROM simba_conversations WHERE user_key = $1 ORDER BY updated_at DESC LIMIT $2",
      [userKey, MAX_CONV_LIST]
    );
    return r.rows.map((x) => ({ id: x.id, title: x.title || "", updated_at: x.updated_at }));
  }
  const m = convMem.get(userKey);
  if (!m) return [];
  return [...m.values()]
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, MAX_CONV_LIST)
    .map((c) => ({ id: c.id, title: c.title || "", updated_at: c.updated_at }));
}

export async function getConversation(userKey, id) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT id, title, messages FROM simba_conversations WHERE user_key = $1 AND id = $2", [userKey, id]);
    const row = r.rows[0];
    return row ? { id: row.id, title: row.title || "", messages: row.messages || [] } : null;
  }
  const c = convMem.get(userKey)?.get(id);
  return c ? { id: c.id, title: c.title || "", messages: c.messages || [] } : null;
}

export async function saveConversation(userKey, id, title, messages) {
  await ensureReady();
  const msgs = trimMessages(messages);
  const t = String(title || "").slice(0, 200);
  if (pool) {
    await pool.query(
      `INSERT INTO simba_conversations (user_key, id, title, messages, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (user_key, id) DO UPDATE SET title = EXCLUDED.title, messages = EXCLUDED.messages, updated_at = now()`,
      [userKey, id, t, JSON.stringify(msgs)]
    );
  } else {
    if (!convMem.has(userKey)) convMem.set(userKey, new Map());
    convMem.get(userKey).set(id, { id, title: t, messages: msgs, updated_at: new Date().toISOString() });
  }
  return { id, title: t };
}

export async function deleteConversation(userKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_conversations WHERE user_key = $1 AND id = $2", [userKey, id]);
  else convMem.get(userKey)?.delete(id);
}

/* ---- Shared workspace (per user, synced across surfaces) ---------------- */
import { randomUUID as _uuid } from "node:crypto";

export async function listWorkspace(userKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT id, label, content, source, updated_at FROM simba_workspace WHERE user_key = $1 ORDER BY updated_at DESC LIMIT $2", [userKey, MAX_WS_ITEMS]);
    return r.rows.map((x) => ({ id: x.id, label: x.label, content: x.content, source: x.source || "", updated_at: x.updated_at }));
  }
  const m = wsMem.get(userKey);
  if (!m) return [];
  return [...m.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, MAX_WS_ITEMS);
}

export async function saveWorkspace(userKey, { id, label, content, source }) {
  await ensureReady();
  const item = {
    id: id || _uuid(),
    label: String(label || "Notis").slice(0, 200),
    content: String(content || "").slice(0, MAX_WS_CONTENT),
    source: String(source || "").slice(0, 40),
    updated_at: new Date().toISOString(),
  };
  if (pool) {
    await pool.query(
      `INSERT INTO simba_workspace (user_key, id, label, content, source, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (user_key, id) DO UPDATE SET label = EXCLUDED.label, content = EXCLUDED.content, source = EXCLUDED.source, updated_at = now()`,
      [userKey, item.id, item.label, item.content, item.source]
    );
    // Trim to the cap (keep newest).
    await pool.query(
      `DELETE FROM simba_workspace WHERE user_key = $1 AND id NOT IN (
         SELECT id FROM simba_workspace WHERE user_key = $1 ORDER BY updated_at DESC LIMIT $2)`,
      [userKey, MAX_WS_ITEMS]
    );
  } else {
    if (!wsMem.has(userKey)) wsMem.set(userKey, new Map());
    wsMem.get(userKey).set(item.id, item);
  }
  return item;
}

export async function deleteWorkspace(userKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_workspace WHERE user_key = $1 AND id = $2", [userKey, id]);
  else wsMem.get(userKey)?.delete(id);
}

// Compact recent workspace items for the system prompt.
export async function workspaceContext(userKey, maxChars = 3500) {
  const items = await listWorkspace(userKey);
  const parts = [];
  let used = 0;
  for (const it of items) {
    const block = `• ${it.label}${it.source ? ` (${it.source})` : ""}: ${String(it.content).replace(/\s+/g, " ").slice(0, 900)}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.join("\n");
}

// Rename without touching the stored messages.
export async function renameConversation(userKey, id, title) {
  await ensureReady();
  const t = String(title || "").slice(0, 200);
  if (pool) {
    await pool.query("UPDATE simba_conversations SET title = $3, updated_at = now() WHERE user_key = $1 AND id = $2", [userKey, id, t]);
  } else {
    const c = convMem.get(userKey)?.get(id);
    if (c) { c.title = t; c.updated_at = new Date().toISOString(); }
  }
  return { id, title: t };
}
