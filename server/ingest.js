/*
 * Vault auto-ingest — sync SharePoint/OneDrive folders into the knowledge vault.
 *
 * An org admin pastes a sharing link to a folder; we resolve it via Graph, then
 * on a schedule (and on demand) list the folder, extract text from new/changed
 * files, and upsert them as vault entries (which get the normal embeddings +
 * chunking, so retrieval and citations work over synced documents too). Files
 * removed from the folder are removed from the vault on the next sync.
 *
 * Extraction (no new dependencies):
 *  - txt/md/csv/json:  as-is
 *  - docx/pptx:        minimal ZIP reader (zlib.inflateRawSync) + XML strip
 *  - xlsx:             ExcelJS (already a dependency) → sheet cells as text
 *  - pdf:              Claude Haiku document block (needs ANTHROPIC_API_KEY)
 *
 * Needs the APPLICATION Graph permission Files.Read.All (admin consent) — the
 * sync runs unattended, as the app.
 */
import { zlibSync } from "./zipmini.js";
import ExcelJS from "exceljs";
import { randomUUID } from "node:crypto";
import { getPool, usingPostgres } from "./db.js";
import { appOnlyGraphToken, listFolderChildren, downloadDriveItem, resolveShareUrl } from "./graph.js";
import { upsertExternal, removeExternal, listExternalIds } from "./vault.js";

export { usingPostgres };

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TEXT = 19000;            // vault content cap is 20k — leave headroom
const MAX_FILES_PER_SYNC = 40;     // per source per pass; the rest next pass
const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log"]);

let pool = null;
let ready = null;
const memSources = new Map(); // orgKey -> Map(id -> source)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_ingest_sources (
       id         TEXT PRIMARY KEY,
       org_key    TEXT NOT NULL,
       name       TEXT NOT NULL,
       drive_id   TEXT NOT NULL,
       item_id    TEXT NOT NULL,
       web_url    TEXT,
       enabled    BOOLEAN NOT NULL DEFAULT true,
       state      JSONB NOT NULL DEFAULT '{}'::jsonb,
       created_by TEXT,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_ingest_org ON simba_ingest_sources (org_key)");
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] ingest init failed:", e.message); pool = null; });
  return ready;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);
function publicSource(s) {
  return {
    id: s.id, name: s.name, webUrl: s.web_url || "", enabled: s.enabled !== false,
    lastSync: s.state?.lastSync || null, files: s.state?.files ? Object.keys(s.state.files).length : 0,
    lastError: s.state?.lastError || null,
  };
}

/* ---- Source CRUD --------------------------------------------------------- */
export async function listSources(orgKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_ingest_sources WHERE org_key=$1 ORDER BY name LIMIT 50", [orgKey]);
    return r.rows.map(publicSource);
  }
  return [...(memSources.get(orgKey)?.values() || [])].map(publicSource);
}
async function rawSources(orgKey) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_ingest_sources WHERE org_key=$1 LIMIT 50", [orgKey]); return r.rows; }
  return [...(memSources.get(orgKey)?.values() || [])];
}
export async function allEnabledSources() {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_ingest_sources WHERE enabled=true"); return r.rows; }
  const out = [];
  for (const m of memSources.values()) for (const s of m.values()) if (s.enabled !== false) out.push(s);
  return out;
}

// Create from a pasted sharing link — resolve to drive+item first.
export async function createSource(orgKey, { url, name, createdBy }) {
  await ensureReady();
  const token = await appOnlyGraphToken(orgKey);
  const item = await resolveShareUrl(token, clean(url, 800));
  if (!item.isFolder) throw Object.assign(new Error("Länken pekar på en fil — ange en mapp."), { status: 400 });
  const s = {
    id: randomUUID(), org_key: orgKey,
    name: clean(name, 120) || item.name,
    drive_id: item.driveId, item_id: item.itemId, web_url: item.webUrl,
    enabled: true, state: {}, created_by: clean(createdBy, 200),
  };
  if (pool) {
    await pool.query(
      "INSERT INTO simba_ingest_sources (id,org_key,name,drive_id,item_id,web_url,enabled,state,created_by) VALUES ($1,$2,$3,$4,$5,$6,true,'{}'::jsonb,$7)",
      [s.id, orgKey, s.name, s.drive_id, s.item_id, s.web_url, s.created_by]
    );
  } else {
    if (!memSources.has(orgKey)) memSources.set(orgKey, new Map());
    memSources.get(orgKey).set(s.id, s);
  }
  return publicSource(s);
}

export async function setSourceEnabled(orgKey, id, enabled) {
  await ensureReady();
  if (pool) await pool.query("UPDATE simba_ingest_sources SET enabled=$3, updated_at=now() WHERE org_key=$1 AND id=$2", [orgKey, id, !!enabled]);
  else { const s = memSources.get(orgKey)?.get(id); if (s) s.enabled = !!enabled; }
}

export async function deleteSource(orgKey, id) {
  await ensureReady();
  // Remove the synced vault entries too — the source owns them.
  const ids = await listExternalIds(orgKey, `${id}:`);
  for (const extId of ids) await removeExternal(orgKey, extId);
  if (pool) await pool.query("DELETE FROM simba_ingest_sources WHERE org_key=$1 AND id=$2", [orgKey, id]);
  else memSources.get(orgKey)?.delete(id);
}

async function saveState(orgKey, id, state) {
  await ensureReady();
  if (pool) await pool.query("UPDATE simba_ingest_sources SET state=$3::jsonb, updated_at=now() WHERE org_key=$1 AND id=$2", [orgKey, id, JSON.stringify(state)]);
  else { const s = memSources.get(orgKey)?.get(id); if (s) s.state = state; }
}

/* ---- Text extraction ------------------------------------------------------ */
const stripXml = (xml) => String(xml)
  .replace(/<\/(w:p|a:p)>/g, "\n")            // paragraph ends → newlines
  .replace(/<[^>]+>/g, "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

async function extractXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow((row) => {
      const cells = (row.values || []).slice(1).map((v) => (v && typeof v === "object" ? (v.result ?? v.text ?? "") : v ?? ""));
      const line = cells.join("\t").trim();
      if (line) rows.push(line);
    });
    if (rows.length) parts.push(`[Blad: ${ws.name}]\n${rows.slice(0, 400).join("\n")}`);
  });
  return parts.join("\n\n");
}

// PDF text via Claude Haiku (documents are parsed server-side by the API).
async function extractPdf(buffer, name, anthropic) {
  if (!anthropic) return "";
  const resp = await anthropic.messages.create({
    model: process.env.SIMBA_MODEL_SIMPLE || "claude-haiku-4-5-20251001",
    max_tokens: 8000,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } },
        { type: "text", text: `Extrahera ALL text ur dokumentet "${name}" ordagrant (rubriker, stycken, tabeller som rader). Svara enbart med texten.` },
      ],
    }],
  });
  return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

export async function extractText(name, buffer, anthropic) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (TEXT_EXTS.has(ext)) return buffer.toString("utf8");
  if (ext === "docx") {
    const doc = zlibSync(buffer, "word/document.xml");
    return doc ? stripXml(doc) : "";
  }
  if (ext === "pptx") {
    const slides = [];
    for (let i = 1; i <= 60; i++) {
      const xml = zlibSync(buffer, `ppt/slides/slide${i}.xml`);
      if (!xml) break;
      const t = stripXml(xml);
      if (t) slides.push(`[Bild ${i}]\n${t}`);
    }
    return slides.join("\n\n");
  }
  if (ext === "xlsx") return await extractXlsx(buffer);
  if (ext === "pdf") return await extractPdf(buffer, name, anthropic);
  return ""; // unsupported type → skipped
}

/* ---- Sync ----------------------------------------------------------------- */
// Sync one source: diff the folder against synced state, ingest new/changed
// files, remove entries whose files are gone. Returns a summary.
export async function syncSource(orgKey, source, anthropic) {
  const state = source.state || {};
  const known = state.files || {}; // driveItemId -> lastModified
  const token = await appOnlyGraphToken(orgKey);
  const children = await listFolderChildren(token, source.drive_id, source.item_id);
  const files = children.filter((c) => !c.isFolder);

  let added = 0, updated = 0, removed = 0, skipped = 0, failed = 0;
  let budget = MAX_FILES_PER_SYNC;
  for (const f of files) {
    if (budget <= 0) break;
    const prev = known[f.id];
    if (prev === f.modified) continue; // unchanged
    if (f.size > MAX_FILE_BYTES) { skipped++; known[f.id] = f.modified; continue; }
    budget--;
    try {
      const { buffer } = await downloadDriveItem(token, f.driveId, f.id, MAX_FILE_BYTES);
      const text = (await extractText(f.name, buffer, anthropic) || "").slice(0, MAX_TEXT);
      if (!text.trim()) { skipped++; known[f.id] = f.modified; continue; }
      await upsertExternal(orgKey, `${source.id}:${f.id}`, {
        topic: source.name, title: f.name,
        content: `[Synkad fil från ${source.name}]\n${text}`,
      });
      if (prev) updated++; else added++;
      known[f.id] = f.modified;
    } catch (e) {
      failed++;
      console.error(`[Simba] ingest failed (${f.name}):`, e?.message || e);
    }
  }
  // Mirror deletions: entries whose file no longer exists in the folder.
  const liveIds = new Set(files.map((f) => f.id));
  for (const id of Object.keys(known)) {
    if (!liveIds.has(id)) {
      await removeExternal(orgKey, `${source.id}:${id}`);
      delete known[id];
      removed++;
    }
  }
  const summary = { added, updated, removed, skipped, failed, total: files.length };
  await saveState(orgKey, source.id, { ...state, files: known, lastSync: new Date().toISOString(), lastError: null, lastResult: summary });
  return summary;
}

export async function syncSourceById(orgKey, id, anthropic) {
  const s = (await rawSources(orgKey)).find((x) => x.id === id);
  if (!s) throw Object.assign(new Error("Källan hittades inte."), { status: 404 });
  try {
    return await syncSource(orgKey, s, anthropic);
  } catch (e) {
    await saveState(orgKey, s.id, { ...(s.state || {}), lastError: (e?.message || "Fel").slice(0, 300) }).catch(() => {});
    throw e;
  }
}

// Scheduler hook: sync every enabled source that is due (default every 60 min).
const SYNC_EVERY_MS = Number(process.env.SIMBA_INGEST_INTERVAL_MIN || 60) * 60_000;
export async function tickIngest(anthropic) {
  let sources = [];
  try { sources = await allEnabledSources(); } catch (e) { console.error("[Simba] ingest list failed:", e?.message || e); return; }
  for (const s of sources) {
    const last = s.state?.lastSync ? Date.parse(s.state.lastSync) : 0;
    if (Date.now() - last < SYNC_EVERY_MS) continue;
    try {
      const r = await syncSource(s.org_key, s, anthropic);
      if (r.added || r.updated || r.removed) console.log(`[Simba] ingest ${s.name}: +${r.added} ~${r.updated} -${r.removed}`);
    } catch (e) {
      console.error(`[Simba] ingest ${s.name} failed:`, e?.message || e);
      await saveState(s.org_key, s.id, { ...(s.state || {}), lastError: (e?.message || "Fel").slice(0, 300), lastSync: new Date().toISOString() }).catch(() => {});
    }
  }
}
