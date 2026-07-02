/*
 * Watchers — proactive monitoring ("bevakningar").
 *
 * A user sets a watcher on something and Simba checks it on a schedule and
 * emails them when the condition is met. Two kinds:
 *   - connector: fetch a whitelisted data-source endpoint and judge a natural-
 *     language condition against the data ("varna om summan avviker >10%").
 *     The judging is done by the fast model, which sees the previous value so
 *     "avviker/ändras" conditions work.
 *   - folder:    watch a SharePoint/OneDrive folder for new/changed files.
 *
 * Notifications are throttled: a watcher won't re-alert for the same finding
 * (state.lastSignature) and has a cooldown between alerts.
 */
import { getPool, usingPostgres } from "./db.js";
import { randomUUID } from "node:crypto";
import { queryConnector } from "./connectors.js";
import { appOnlyGraphToken, listFolderChildren, resolveShareUrl, sendMailAsUser } from "./graph.js";
import { notifyUser } from "./push.js";

export { usingPostgres };

const CHECK_DEFAULT_MIN = 60;
const COOLDOWN_MS = 6 * 3600_000; // don't re-alert the same watcher within 6h

let pool = null;
let ready = null;
const mem = new Map(); // userKey -> Map(id -> watcher)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_watchers (
       id         TEXT PRIMARY KEY,
       user_key   TEXT NOT NULL,
       org_key    TEXT NOT NULL,
       name       TEXT NOT NULL,
       kind       TEXT NOT NULL,
       config     JSONB NOT NULL DEFAULT '{}'::jsonb,
       state      JSONB NOT NULL DEFAULT '{}'::jsonb,
       enabled    BOOLEAN NOT NULL DEFAULT true,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_watchers_user ON simba_watchers (user_key)");
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] watchers init failed:", e.message); pool = null; });
  return ready;
}

const clean = (s, n) => String(s ?? "").trim().slice(0, n);
const pub = (w) => ({
  id: w.id, name: w.name, kind: w.kind, enabled: w.enabled !== false,
  config: { ...w.config, /* nothing secret stored here */ },
  lastCheck: w.state?.lastCheck || null, lastAlert: w.state?.lastAlert || null, lastError: w.state?.lastError || null,
});

export async function listWatchers(userKey) {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_watchers WHERE user_key=$1 ORDER BY name LIMIT 50", [userKey]); return r.rows.map(pub); }
  return [...(mem.get(userKey)?.values() || [])].map(pub);
}

export async function createWatcher(userKey, orgKey, { name, kind, config }) {
  await ensureReady();
  const k = ["connector", "folder"].includes(kind) ? kind : null;
  if (!k) throw Object.assign(new Error("Okänd bevakningstyp."), { status: 400 });
  const cfg = {};
  if (k === "connector") {
    cfg.connectorId = clean(config?.connectorId, 80);
    cfg.endpointKey = clean(config?.endpointKey, 80);
    cfg.condition = clean(config?.condition, 500);
    if (!cfg.connectorId || !cfg.endpointKey || !cfg.condition) throw Object.assign(new Error("Ange datakälla, endpoint och villkor."), { status: 400 });
  } else {
    // Resolve the folder link now so ticks don't re-resolve.
    const token = await appOnlyGraphToken(orgKey);
    const item = await resolveShareUrl(token, clean(config?.url, 800));
    if (!item.isFolder) throw Object.assign(new Error("Länken pekar på en fil — ange en mapp."), { status: 400 });
    cfg.driveId = item.driveId; cfg.itemId = item.itemId; cfg.folderName = item.name;
  }
  cfg.email = clean(config?.email, 200);
  if (!cfg.email) throw Object.assign(new Error("Ange en e-postadress för notiser."), { status: 400 });
  cfg.intervalMinutes = Math.min(1440, Math.max(15, Number(config?.intervalMinutes) || CHECK_DEFAULT_MIN));
  const w = { id: randomUUID(), user_key: userKey, org_key: orgKey, name: clean(name, 120) || "Bevakning", kind: k, config: cfg, state: {}, enabled: true };
  if (pool) await pool.query("INSERT INTO simba_watchers (id,user_key,org_key,name,kind,config,state,enabled) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'{}'::jsonb,true)", [w.id, userKey, orgKey, w.name, w.kind, JSON.stringify(w.config)]);
  else { if (!mem.has(userKey)) mem.set(userKey, new Map()); mem.get(userKey).set(w.id, w); }
  return pub(w);
}

export async function deleteWatcher(userKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_watchers WHERE user_key=$1 AND id=$2", [userKey, id]);
  else mem.get(userKey)?.delete(id);
}

async function saveState(id, state) {
  await ensureReady();
  if (pool) await pool.query("UPDATE simba_watchers SET state=$2::jsonb, updated_at=now() WHERE id=$1", [id, JSON.stringify(state)]);
  else { for (const m of mem.values()) { const w = m.get(id); if (w) { w.state = state; return; } } }
}

async function allEnabled() {
  await ensureReady();
  if (pool) { const r = await pool.query("SELECT * FROM simba_watchers WHERE enabled=true"); return r.rows; }
  const out = []; for (const m of mem.values()) for (const w of m.values()) if (w.enabled !== false) out.push(w);
  return out;
}

// Ask the fast model whether the condition is met. Sees the previous snapshot
// so relative conditions ("ändras", "avviker mot förra kontrollen") work.
async function judgeCondition(client, model, condition, data, prevData) {
  const sys = 'Du är en bevakningsvakt. Bedöm STRIKT om villkoret är uppfyllt utifrån datan. Svara ENBART med JSON: {"triggered":true/false,"summary":"<kort svensk förklaring med de faktiska värdena>"}. Om datan inte räcker för att avgöra: triggered=false.';
  const content = `Villkor: ${condition}\n\nAktuell data:\n${JSON.stringify(data).slice(0, 20000)}\n\nFöregående kontrolls data (för jämförelser):\n${prevData ? JSON.stringify(prevData).slice(0, 10000) : "(första kontrollen)"}`;
  const resp = await client.messages.create({ model, max_tokens: 500, system: sys, messages: [{ role: "user", content }] });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { triggered: false }; } catch { return { triggered: false }; }
}

// Evaluate one watcher; returns { triggered, summary } and updates its state.
export async function checkWatcher(client, simpleModel, w) {
  const cfg = w.config || {};
  const state = w.state || {};
  let triggered = false, summary = "";
  if (w.kind === "connector") {
    const r = await queryConnector(w.org_key, cfg.connectorId, cfg.endpointKey, {});
    const verdict = await judgeCondition(client, simpleModel, cfg.condition, r.data, state.lastData);
    triggered = !!verdict.triggered;
    summary = clean(verdict.summary, 500);
    state.lastData = r.data && JSON.stringify(r.data).length < 30000 ? r.data : null; // keep a bounded snapshot
  } else if (w.kind === "folder") {
    const token = await appOnlyGraphToken(w.org_key);
    const files = (await listFolderChildren(token, cfg.driveId, cfg.itemId)).filter((f) => !f.isFolder);
    const known = state.files || {};
    const news = files.filter((f) => !known[f.id]);
    const changed = files.filter((f) => known[f.id] && known[f.id] !== f.modified);
    if (Object.keys(known).length && (news.length || changed.length)) {
      triggered = true;
      summary = [
        news.length ? `Nya filer: ${news.slice(0, 5).map((f) => f.name).join(", ")}${news.length > 5 ? "…" : ""}` : "",
        changed.length ? `Ändrade: ${changed.slice(0, 5).map((f) => f.name).join(", ")}${changed.length > 5 ? "…" : ""}` : "",
      ].filter(Boolean).join(" · ");
    }
    state.files = Object.fromEntries(files.map((f) => [f.id, f.modified]));
  }
  state.lastCheck = new Date().toISOString();
  state.lastError = null;

  // Throttle: same finding, or alerting again within the cooldown → stay quiet.
  const signature = summary.slice(0, 200);
  const lastAlertMs = state.lastAlert ? Date.parse(state.lastAlert) : 0;
  const shouldAlert = triggered && signature && signature !== state.lastSignature && Date.now() - lastAlertMs > COOLDOWN_MS;
  if (shouldAlert) {
    state.lastAlert = new Date().toISOString();
    state.lastSignature = signature;
  }
  await saveState(w.id, state);
  return { triggered: shouldAlert, summary };
}

const esc = (s) => String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Scheduler hook: check all due watchers and mail alerts.
export async function tickWatchers(client, simpleModel) {
  let watchers = [];
  try { watchers = await allEnabled(); } catch (e) { console.error("[Simba] watchers list failed:", e?.message || e); return; }
  for (const w of watchers) {
    const everyMs = Math.max(15, Number(w.config?.intervalMinutes) || CHECK_DEFAULT_MIN) * 60_000;
    const last = w.state?.lastCheck ? Date.parse(w.state.lastCheck) : 0;
    if (Date.now() - last < everyMs) continue;
    try {
      const { triggered, summary } = await checkWatcher(client, simpleModel, w);
      if (triggered) {
        // Push first (instant, reaches the phone), then the email record.
        await notifyUser(w.user_key, { title: `🔔 ${w.name}`, body: summary }).catch(() => {});
        const [, oid] = String(w.user_key).split(":");
        const token = await appOnlyGraphToken(w.org_key);
        await sendMailAsUser(token, oid, w.config.email, `🔔 Simba-bevakning: ${w.name}`,
          `<p><b>${esc(w.name)}</b> har slagit larm.</p><p>${esc(summary)}</p><hr><p style="color:#888;font-size:12px">Skickat automatiskt av Simba AI. Hantera bevakningar i Simba-appen.</p>`);
        console.log(`[Simba] watcher ${w.id} (${w.name}) alerted`);
      }
    } catch (e) {
      console.error(`[Simba] watcher ${w.id} failed:`, e?.message || e);
      await saveState(w.id, { ...(w.state || {}), lastCheck: new Date().toISOString(), lastError: (e?.message || "Fel").slice(0, 300) }).catch(() => {});
    }
  }
}
