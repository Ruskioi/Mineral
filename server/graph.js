/*
 * Microsoft Graph access via the On-Behalf-Of (OBO) flow.
 *
 * The task pane sends its Office SSO bootstrap token; the server exchanges it
 * (with the app's client secret) for a Graph token scoped to Files.Read, then
 * lists / downloads the signed-in user's OneDrive/SharePoint files.
 *
 * Cloud files are opt-in: they require AAD_CLIENT_ID + AAD_CLIENT_SECRET and the
 * Azure app must have the delegated Microsoft Graph permission Files.Read.
 */
const AAD_CLIENT_ID = process.env.AAD_CLIENT_ID || process.env.SIMBA_AAD_CLIENT_ID || "";
const AAD_CLIENT_SECRET = process.env.AAD_CLIENT_SECRET || "";
const AAD_TENANT = process.env.AAD_TENANT || "common";

export const graphConfigured = Boolean(AAD_CLIENT_ID && AAD_CLIENT_SECRET);

const TOKEN_URL = `https://login.microsoftonline.com/${AAD_TENANT}/oauth2/v2.0/token`;
const GRAPH = "https://graph.microsoft.com/v1.0";

/** Exchange the Office bootstrap token for a Microsoft Graph access token. */
export async function oboGraphToken(bootstrapToken) {
  if (!graphConfigured) throw Object.assign(new Error("Cloud files are not configured."), { status: 501 });
  if (!bootstrapToken) throw Object.assign(new Error("Missing bearer token."), { status: 401 });
  const body = new URLSearchParams({
    client_id: AAD_CLIENT_ID,
    client_secret: AAD_CLIENT_SECRET,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: bootstrapToken,
    scope: "https://graph.microsoft.com/Files.Read",
    requested_token_use: "on_behalf_of",
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    console.error("[Simba] OBO exchange failed:", r.status, detail);
    throw Object.assign(new Error("On-behalf-of token exchange failed."), { status: 502 });
  }
  const j = await r.json();
  return j.access_token;
}

async function graphGet(path, token) {
  return fetch(GRAPH + path, { headers: { Authorization: `Bearer ${token}` } });
}

/* ---- App-only (client-credentials) access for unattended scheduled jobs ---
 * A scheduled job runs when the user is offline, so we can't use their token.
 * Instead the app authenticates as ITSELF (per the file's tenant) and edits the
 * file by drive+item id. This needs the *application* Graph permission
 * Files.ReadWrite.All with admin consent in that tenant. Opt-in & separate from
 * the delegated OBO flow above.
 */
export const graphAppConfigured = Boolean(AAD_CLIENT_ID && AAD_CLIENT_SECRET);

const appTokenCache = new Map(); // tenantId -> { token, exp }

export async function appOnlyGraphToken(tenantId) {
  if (!graphAppConfigured) throw Object.assign(new Error("App-only Graph is not configured."), { status: 501 });
  const tid = tenantId || AAD_TENANT;
  if (!tid || tid === "common") throw Object.assign(new Error("App-only Graph needs a concrete tenant id."), { status: 400 });
  const cached = appTokenCache.get(tid);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    client_id: AAD_CLIENT_ID,
    client_secret: AAD_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    console.error("[Simba] app-only token failed:", r.status, detail);
    throw Object.assign(new Error("App-only token request failed."), { status: 502 });
  }
  const j = await r.json();
  appTokenCache.set(tid, { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}

/** Resolve a /me drive item's driveId + name (used at job-creation time via OBO),
 *  so an unattended run can later address it by drive+item. */
export async function itemDriveInfo(graphToken, itemId) {
  const r = await graphGet(`/me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,parentReference`, graphToken);
  if (!r.ok) throw Object.assign(new Error("File not found."), { status: r.status });
  const j = await r.json();
  return { id: j.id, name: j.name, driveId: j.parentReference?.driveId || "" };
}

/** Download a drive item's bytes by drive+item id (app-only). */
export async function downloadDriveItem(graphToken, driveId, itemId, maxBytes = Infinity) {
  const base = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`;
  const metaR = await graphGet(`${base}?$select=name,size`, graphToken);
  if (!metaR.ok) throw Object.assign(new Error("File not found."), { status: metaR.status });
  const meta = await metaR.json();
  if (typeof meta.size === "number" && meta.size > maxBytes) throw Object.assign(new Error("File too large."), { status: 413 });
  const contentR = await graphGet(`${base}/content`, graphToken);
  if (!contentR.ok) throw Object.assign(new Error("File download failed."), { status: contentR.status });
  const buffer = Buffer.from(await contentR.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error("File too large."), { status: 413 });
  return { name: meta.name, size: meta.size ?? buffer.length, buffer };
}

/** Send an email as a user (app-only). Needs the application Graph permission
 *  Mail.Send (admin consent). Used to notify a user when their scheduled job ran. */
export async function sendMailAsUser(graphToken, senderOid, toEmail, subject, html) {
  const r = await fetch(`${GRAPH}/users/${encodeURIComponent(senderOid)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${graphToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: { subject, body: { contentType: "HTML", content: html }, toRecipients: [{ emailAddress: { address: toEmail } }] },
      saveToSentItems: false,
    }),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    throw Object.assign(new Error(`sendMail failed (${r.status}). ${detail}`), { status: r.status });
  }
  return true;
}

/** Overwrite a drive item's content by drive+item id (app-only). */
export async function uploadDriveItem(graphToken, driveId, itemId, buffer) {
  const r = await fetch(`${GRAPH}/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${graphToken}`, "Content-Type": "application/octet-stream" },
    body: buffer,
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    throw Object.assign(new Error(`File upload failed (${r.status}). ${detail}`), { status: r.status });
  }
  return true;
}

/** Search the user's OneDrive (or list recent files when query is empty). */
export async function searchFiles(graphToken, query) {
  const q = String(query || "").trim();
  const sel = "$select=id,name,size,webUrl,lastModifiedDateTime,file,folder&$top=25";
  const path = q
    ? `/me/drive/root/search(q='${encodeURIComponent(q.replace(/'/g, "''"))}')?${sel}`
    : `/me/drive/recent?${sel}`;
  const r = await graphGet(path, graphToken);
  if (!r.ok) throw Object.assign(new Error("Graph listing failed."), { status: r.status });
  const j = await r.json();
  return (j.value || [])
    .filter((it) => it && it.name && !it.folder)
    .map((it) => ({ id: it.id, name: it.name, size: it.size, modified: it.lastModifiedDateTime, url: it.webUrl }))
    .slice(0, 25);
}

/** Download a file's bytes (with its name/size). Rejects oversized files BEFORE
 * fetching content, so a huge drive item can't be buffered into server memory. */
export async function downloadFile(graphToken, id, maxBytes = Infinity) {
  const metaR = await graphGet(`/me/drive/items/${encodeURIComponent(id)}?$select=name,size`, graphToken);
  if (!metaR.ok) throw Object.assign(new Error("File not found."), { status: metaR.status });
  const meta = await metaR.json();
  if (typeof meta.size === "number" && meta.size > maxBytes)
    throw Object.assign(new Error("File too large."), { status: 413 });
  const contentR = await graphGet(`/me/drive/items/${encodeURIComponent(id)}/content`, graphToken);
  if (!contentR.ok) throw Object.assign(new Error("File download failed."), { status: contentR.status });
  const buffer = Buffer.from(await contentR.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error("File too large."), { status: 413 }); // defense-in-depth
  return { name: meta.name, size: meta.size ?? buffer.length, buffer };
}
