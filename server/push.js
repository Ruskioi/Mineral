/*
 * Web-push notifications — Simba taps you on the shoulder.
 *
 * Watchers, uppdrag and agents work while the app is closed; push is how the
 * result reaches the user's phone/desktop (the installed PWA registers a
 * service worker that shows the notification). Enabled by setting VAPID keys:
 *
 *   npx web-push generate-vapid-keys
 *   SIMBA_VAPID_PUBLIC=...  SIMBA_VAPID_PRIVATE=...  (+ optional SIMBA_VAPID_SUBJECT)
 *
 * Subscriptions are per user & device, stored in Postgres (memory fallback).
 * Dead subscriptions (410/404 from the push service) are pruned automatically.
 * Always best-effort: a notification must never break the flow that sent it.
 */
import { getPool, usingPostgres } from "./db.js";

const PUB = process.env.SIMBA_VAPID_PUBLIC || "";
const PRIV = process.env.SIMBA_VAPID_PRIVATE || "";
const SUBJECT = process.env.SIMBA_VAPID_SUBJECT || "mailto:simba@example.com";

export const pushEnabled = Boolean(PUB && PRIV);
export const pushPublicKey = PUB;

let webpush = null; // lazy import — dependency only needed when configured
async function lib() {
  if (!pushEnabled) return null;
  if (!webpush) {
    webpush = (async () => {
      const m = (await import("web-push")).default;
      m.setVapidDetails(SUBJECT, PUB, PRIV);
      return m;
    })();
  }
  return webpush;
}

let pool = null;
let ready = null;
const mem = new Map(); // userKey -> Map(endpoint -> subscription)

async function init() {
  if (!usingPostgres) return;
  pool = getPool(); // shared pool (see db.js)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_push (
       user_key   TEXT NOT NULL,
       endpoint   TEXT NOT NULL,
       sub        JSONB NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (user_key, endpoint)
     )`
  );
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] push init failed:", e.message); pool = null; });
  return ready;
}

export async function saveSubscription(userKey, sub) {
  await ensureReady();
  const endpoint = String(sub?.endpoint || "");
  if (!endpoint || !sub?.keys) throw Object.assign(new Error("Ogiltig prenumeration."), { status: 400 });
  if (pool) {
    await pool.query(
      `INSERT INTO simba_push (user_key, endpoint, sub) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (user_key, endpoint) DO UPDATE SET sub = EXCLUDED.sub`,
      [userKey, endpoint.slice(0, 1000), JSON.stringify(sub)]
    );
  } else {
    if (!mem.has(userKey)) mem.set(userKey, new Map());
    mem.get(userKey).set(endpoint, sub);
  }
}

export async function deleteSubscription(userKey, endpoint) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_push WHERE user_key=$1 AND endpoint=$2", [userKey, String(endpoint || "").slice(0, 1000)]);
  else mem.get(userKey)?.delete(String(endpoint || ""));
}

async function subsFor(userKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT endpoint, sub FROM simba_push WHERE user_key=$1 LIMIT 10", [userKey]);
    return r.rows.map((x) => x.sub);
  }
  return [...(mem.get(userKey)?.values() || [])];
}

// Send a notification to every device the user enabled. Best-effort.
export async function notifyUser(userKey, { title, body, url }) {
  if (!pushEnabled || !userKey) return;
  try {
    const wp = await lib();
    const subs = await subsFor(userKey);
    if (!subs.length) return;
    const payload = JSON.stringify({
      title: String(title || "Simba").slice(0, 120),
      body: String(body || "").slice(0, 400),
      url: String(url || "/").slice(0, 500),
    });
    await Promise.all(subs.map(async (sub) => {
      try { await wp.sendNotification(sub, payload, { TTL: 3600 }); }
      catch (e) {
        // 404/410 = the browser dropped the subscription — prune it.
        if (e?.statusCode === 404 || e?.statusCode === 410) await deleteSubscription(userKey, sub?.endpoint).catch(() => {});
      }
    }));
  } catch (e) { console.error("[Simba] push notify failed:", e?.message || e); }
}
