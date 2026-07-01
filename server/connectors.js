/*
 * Finance / business-system connectors — a secure bridge between Simba and your
 * economy systems (Fortnox, Visma, project tools, any REST API).
 *
 * An org admin configures named data sources: a base URL, secret auth headers
 * (kept SERVER-SIDE, never sent to the browser), and a whitelist of read-only
 * endpoints. Simba can then call those endpoints and report on companies,
 * invoicing, projects, etc. Security model:
 *   - org-scoped (per Microsoft tenant).
 *   - HTTPS only; only whitelisted endpoint paths (the host is fixed by config,
 *     so the model can't be tricked into calling arbitrary URLs / SSRF).
 *   - Reads (GET) are open in-org. WRITES (POST/PUT, e.g. posting reported hours
 *     into a project system) go ONLY through the org-agent approval flow — a
 *     human approves the exact bodies; there is no model tool that writes.
 *   - Responses size-capped; secrets never leave the server.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";

export const usingPostgres = Boolean(process.env.DATABASE_URL);

const MAX_CONNECTORS = 50;
const MAX_RESP_BYTES = 300_000;
const TIMEOUT_MS = 20_000;

let pool = null;
let ready = null;
const mem = new Map(); // orgKey -> Map(id -> connector)

function makeSsl() {
  if (process.env.PGSSL_DISABLE) return false;
  if (process.env.PGSSL_CA) return { ca: process.env.PGSSL_CA, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

async function init() {
  if (!usingPostgres) return;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: makeSsl(), max: 5 });
  await pool.query(
    `CREATE TABLE IF NOT EXISTS simba_connectors (
       id         TEXT PRIMARY KEY,
       org_key    TEXT NOT NULL,
       name       TEXT NOT NULL,
       base_url   TEXT NOT NULL,
       headers    JSONB NOT NULL DEFAULT '{}'::jsonb,
       endpoints  JSONB NOT NULL DEFAULT '[]'::jsonb,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS simba_connectors_org ON simba_connectors (org_key)");
}
function ensureReady() {
  if (!ready) ready = init().catch((e) => { console.error("[Simba] connectors init failed:", e.message); pool = null; });
  return ready;
}

function clean(s, max) { return String(s ?? "").trim().slice(0, max); }
function slug(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); }

function sanitizeEndpoints(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map((e) => ({
    key: slug(e.key || e.label) || "endpoint",
    label: clean(e.label || e.key, 80),
    path: clean(e.path, 300),       // relative path appended to base_url
    description: clean(e.description, 200),
    // GET = read (default). POST/PUT = write; body_template is a JSON string with
    // {{placeholders}} the caller fills in (e.g. {"hours":{{hours}},"employee":"{{person}}"}).
    method: /^(GET|POST|PUT)$/i.test(e.method) ? String(e.method).toUpperCase() : "GET",
    body_template: clean(e.body_template, 4000),
  })).filter((e) => e.path);
}
function sanitizeHeaders(h) {
  const out = {};
  if (h && typeof h === "object") for (const k of Object.keys(h).slice(0, 10)) {
    const key = clean(k, 80); const val = clean(h[k], 4000);
    if (key && val) out[key] = val;
  }
  return out;
}

// Public view: NEVER includes header secret values.
function publicConnector(c) {
  return {
    id: c.id, name: c.name, base_url: c.base_url,
    headerNames: Object.keys(c.headers || {}),
    endpoints: (c.endpoints || []).map((e) => ({ key: e.key, label: e.label, path: e.path, description: e.description, method: e.method || "GET", body_template: e.body_template || "" })),
    updated_at: c.updated_at,
  };
}

async function listRaw(orgKey) {
  await ensureReady();
  if (pool) {
    const r = await pool.query("SELECT * FROM simba_connectors WHERE org_key = $1 ORDER BY name LIMIT $2", [orgKey, MAX_CONNECTORS]);
    return r.rows;
  }
  return [...(mem.get(orgKey)?.values() || [])];
}

export async function listConnectors(orgKey) {
  return (await listRaw(orgKey)).map(publicConnector);
}

export async function createConnector(orgKey, { name, base_url, headers, endpoints }) {
  await ensureReady();
  const base = clean(base_url, 400);
  if (!/^https:\/\//i.test(base)) throw Object.assign(new Error("Bas-URL måste vara HTTPS."), { status: 400 });
  const c = {
    id: randomUUID(), org_key: orgKey,
    name: clean(name, 120) || "Datakälla",
    base_url: base.replace(/\/+$/, ""),
    headers: sanitizeHeaders(headers),
    endpoints: sanitizeEndpoints(endpoints),
    updated_at: new Date().toISOString(),
  };
  if (pool) {
    await pool.query(
      `INSERT INTO simba_connectors (id, org_key, name, base_url, headers, endpoints) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [c.id, orgKey, c.name, c.base_url, JSON.stringify(c.headers), JSON.stringify(c.endpoints)]
    );
  } else {
    if (!mem.has(orgKey)) mem.set(orgKey, new Map());
    mem.get(orgKey).set(c.id, c);
  }
  return publicConnector(c);
}

export async function updateConnector(orgKey, id, patch) {
  await ensureReady();
  const cur = (await listRaw(orgKey)).find((c) => c.id === id);
  if (!cur) return null;
  const next = {
    name: patch.name != null ? clean(patch.name, 120) : cur.name,
    base_url: patch.base_url != null ? clean(patch.base_url, 400).replace(/\/+$/, "") : cur.base_url,
    // Only replace headers when provided (so editing endpoints doesn't wipe secrets).
    headers: patch.headers != null ? sanitizeHeaders(patch.headers) : (cur.headers || {}),
    endpoints: patch.endpoints != null ? sanitizeEndpoints(patch.endpoints) : (cur.endpoints || []),
  };
  if (!/^https:\/\//i.test(next.base_url)) throw Object.assign(new Error("Bas-URL måste vara HTTPS."), { status: 400 });
  if (pool) {
    await pool.query(
      "UPDATE simba_connectors SET name=$3, base_url=$4, headers=$5::jsonb, endpoints=$6::jsonb, updated_at=now() WHERE org_key=$1 AND id=$2",
      [orgKey, id, next.name, next.base_url, JSON.stringify(next.headers), JSON.stringify(next.endpoints)]
    );
  } else {
    Object.assign(mem.get(orgKey).get(id), next, { updated_at: new Date().toISOString() });
  }
  return publicConnector({ id, ...next });
}

export async function deleteConnector(orgKey, id) {
  await ensureReady();
  if (pool) await pool.query("DELETE FROM simba_connectors WHERE org_key = $1 AND id = $2", [orgKey, id]);
  else mem.get(orgKey)?.delete(id);
}

// Shared, hardened GET: HTTPS-only, fixed host (no SSRF), size-capped, timed out.
async function rawGet(baseUrl, path, headers, params, { previewBytes } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) throw Object.assign(new Error("Endast HTTPS tillåts."), { status: 400 });
  const url = new URL(base + "/" + String(path || "").replace(/^\/+/, ""));
  if (url.protocol !== "https:") throw Object.assign(new Error("Endast HTTPS tillåts."), { status: 400 });
  if (params && typeof params === "object") for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(String(k).slice(0, 60), String(v).slice(0, 400));
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: { Accept: "application/json", ...(headers || {}) }, signal: ctrl.signal });
    const text = (await r.text()).slice(0, previewBytes || MAX_RESP_BYTES);
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("Datakällan svarade för långsamt."), { status: 504 });
    throw e;
  } finally { clearTimeout(timer); }
}

// Execute a whitelisted endpoint (GET) and return its data. Secrets stay here.
export async function queryConnector(orgKey, source, endpointKey, params) {
  const all = await listRaw(orgKey);
  const c = all.find((x) => x.id === source) || all.find((x) => (x.name || "").toLowerCase() === String(source || "").toLowerCase());
  if (!c) throw Object.assign(new Error("Okänd datakälla."), { status: 404 });
  const ep = (c.endpoints || []).find((e) => e.key === endpointKey) || (c.endpoints || []).find((e) => (e.label || "").toLowerCase() === String(endpointKey || "").toLowerCase());
  if (!ep) throw Object.assign(new Error("Okänd endpoint för den datakällan."), { status: 404 });
  if ((ep.method || "GET").toUpperCase() !== "GET") throw Object.assign(new Error("Den endpointen är en skriv-endpoint och kan inte läsas."), { status: 400 });
  const r = await rawGet(c.base_url, ep.path, c.headers, params);
  if (!r.ok) throw Object.assign(new Error(`Datakällan svarade ${r.status}.`), { status: 502 });
  return { source: c.name, endpoint: ep.label || ep.key, data: r.data };
}

// Live test while building a connector. If an existing connector id is given,
// its STORED secret headers are merged (so you can test without re-typing them).
export async function testConnector(orgKey, { id, base_url, headers, path, params }) {
  let mergedHeaders = sanitizeHeaders(headers);
  let base = base_url;
  if (id) {
    const cur = (await listRaw(orgKey)).find((c) => c.id === id);
    if (cur) { base = base || cur.base_url; mergedHeaders = { ...(cur.headers || {}), ...mergedHeaders }; }
  }
  const r = await rawGet(base, path, mergedHeaders, params, { previewBytes: 4000 });
  return { ok: r.ok, status: r.status, preview: typeof r.data === "string" ? r.data.slice(0, 4000) : r.data };
}

/* ---- Writing (POST/PUT) — approval-gated, never model-triggered ----------
 * Writes go through the org-agent approval flow: an agent builds the concrete
 * bodies, a human approves, and only then are they sent here. There is no model
 * tool that writes, by design.
 */

// Fill a JSON string template's {{placeholders}} from `values` and parse it.
// String fields must be quoted in the template ("{{person}}"); numeric fields
// left bare ({{hours}}). Values are JSON-string-escaped so names with quotes are
// safe. Throws if the resulting JSON is malformed (surfaced to the admin).
export function renderTemplate(tpl, values) {
  const filled = String(tpl || "{}").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = values && values[k] != null ? values[k] : "";
    return String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "").replace(/\n/g, "\\n");
  });
  try { return JSON.parse(filled); }
  catch { throw Object.assign(new Error("Ogiltig JSON-mall efter ifyllnad — kontrollera mallen och fälten."), { status: 400 }); }
}

// Hardened POST/PUT: HTTPS-only, host fixed by config (no SSRF), size-capped, timed out.
async function rawSend(baseUrl, path, headers, method, body) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) throw Object.assign(new Error("Endast HTTPS tillåts."), { status: 400 });
  const url = new URL(base + "/" + String(path || "").replace(/^\/+/, ""));
  if (url.protocol !== "https:") throw Object.assign(new Error("Endast HTTPS tillåts."), { status: 400 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method, signal: ctrl.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...(headers || {}) },
      body: JSON.stringify(body ?? {}),
    });
    const text = (await r.text()).slice(0, MAX_RESP_BYTES);
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("Datakällan svarade för långsamt."), { status: 504 });
    throw e;
  } finally { clearTimeout(timer); }
}

// Look up a connector's WRITE endpoint (POST/PUT). Secrets stay server-side.
function findWriteEndpoint(c, endpointKey) {
  const ep = (c.endpoints || []).find((e) => e.key === endpointKey) || (c.endpoints || []).find((e) => (e.label || "").toLowerCase() === String(endpointKey || "").toLowerCase());
  if (!ep) throw Object.assign(new Error("Okänd endpoint för den datakällan."), { status: 404 });
  if ((ep.method || "GET").toUpperCase() === "GET") throw Object.assign(new Error("Endpointen är läs-bar (GET), inte en skriv-endpoint."), { status: 400 });
  return ep;
}

// Build the concrete request bodies for a batch of value-rows, WITHOUT sending —
// so an agent can put exactly-what-will-be-posted into an approval for review.
export async function buildWriteRequests(orgKey, connectorId, endpointKey, valuesList) {
  const c = (await listRaw(orgKey)).find((x) => x.id === connectorId);
  if (!c) throw Object.assign(new Error("Okänd datakälla."), { status: 404 });
  const ep = findWriteEndpoint(c, endpointKey);
  const bodies = (valuesList || []).map((v) => renderTemplate(ep.body_template || "{}", v));
  return { connectorId, endpointKey, connectorName: c.name, endpointLabel: ep.label || ep.key, method: ep.method, path: ep.path, bodies };
}

// Execute one write against a connector's write endpoint (called from the approval
// decision handler, after a human approves). Fresh secret headers are re-read here.
export async function writeConnector(orgKey, source, endpointKey, body) {
  const all = await listRaw(orgKey);
  const c = all.find((x) => x.id === source) || all.find((x) => (x.name || "").toLowerCase() === String(source || "").toLowerCase());
  if (!c) throw Object.assign(new Error("Okänd datakälla."), { status: 404 });
  const ep = findWriteEndpoint(c, endpointKey);
  const r = await rawSend(c.base_url, ep.path, c.headers, ep.method, body);
  if (!r.ok) throw Object.assign(new Error(`Datakällan svarade ${r.status}.`), { status: 502 });
  return { source: c.name, endpoint: ep.label || ep.key, status: r.status, data: r.data };
}
