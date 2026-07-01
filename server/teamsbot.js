/*
 * Simba as a Microsoft Teams bot.
 *
 * A thin Bot Framework endpoint: Teams POSTs activities to /api/teams/messages;
 * we verify the Bot Framework JWT, run the model with the SAME per-user identity
 * (aadObjectId + tenantId → the "tid:oid" user key SSO uses), memory and vault
 * retrieval included — so Teams answers are grounded in the same company brain
 * as Excel/Outlook/web — and post the reply back to the conversation.
 *
 * Opt-in: set TEAMS_APP_ID + TEAMS_APP_PASSWORD (from the Azure Bot resource).
 * Register the bot's messaging endpoint as https://DIN_HOST/api/teams/messages
 * and install the Teams app manifest (see docs/teams-manifest.template.json).
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const APP_ID = process.env.TEAMS_APP_ID || "";
const APP_PASSWORD = process.env.TEAMS_APP_PASSWORD || "";
export const teamsConfigured = Boolean(APP_ID && APP_PASSWORD);

const BF_JWKS = createRemoteJWKSet(new URL("https://login.botframework.com/v1/.well-known/keys"));

// Verify an inbound Bot Framework token (Authorization: Bearer ...).
export async function verifyBotToken(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || ""));
  if (!m) throw Object.assign(new Error("Missing bot token."), { status: 401 });
  const { payload } = await jwtVerify(m[1], BF_JWKS, {
    issuer: "https://api.botframework.com",
    audience: APP_ID,
    clockTolerance: 300,
  });
  return payload;
}

// App token for replying (client credentials against the Bot Framework tenant).
let botTok = null; // { token, exp }
async function botToken() {
  if (botTok && botTok.exp > Date.now() + 60_000) return botTok.token;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: APP_ID,
    client_secret: APP_PASSWORD,
    scope: "https://api.botframework.com/.default",
  });
  const r = await fetch("https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!r.ok) throw new Error(`Bot token failed (${r.status}).`);
  const j = await r.json();
  botTok = { token: j.access_token, exp: Date.now() + (Number(j.expires_in || 3600) - 60) * 1000 };
  return botTok.token;
}

// Post an activity (reply) back into the conversation.
export async function sendActivity(serviceUrl, conversationId, activity) {
  const token = await botToken();
  const base = String(serviceUrl || "").replace(/\/+$/, "");
  const r = await fetch(`${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(activity),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 300);
    throw new Error(`Teams reply failed (${r.status}). ${detail}`);
  }
}

// Strip the @Simba mention tags Teams embeds in channel messages.
export function cleanTeamsText(text) {
  return String(text || "").replace(/<at>[^<]*<\/at>/g, "").replace(/\s+/g, " ").trim();
}

/* Per-conversation short history so Teams chats have continuity. In-memory,
 * capped and TTL'd — Teams threads are ephemeral working conversations; the
 * durable brain (memory, vault) lives in the shared stores. */
const convs = new Map(); // conversationId -> { at, messages }
const CONV_TTL = 2 * 3600_000;
const CONV_MAX = 24;
export function conversationHistory(id) {
  const c = convs.get(id);
  if (!c || Date.now() - c.at > CONV_TTL) { const fresh = { at: Date.now(), messages: [] }; convs.set(id, fresh); return fresh.messages; }
  c.at = Date.now();
  return c.messages;
}
export function rememberTurn(id, userText, assistantText) {
  const msgs = conversationHistory(id);
  msgs.push({ role: "user", content: userText }, { role: "assistant", content: assistantText });
  while (msgs.length > CONV_MAX) msgs.shift();
  if (convs.size > 2000) convs.delete(convs.keys().next().value);
}

export const TEAMS_SYSTEM =
  "Du är Simba, företagets AI-assistent, här inne i Microsoft Teams. Svara kort och konkret på svenska " +
  "(Teams är ett chattformat — inga långa uppsatser om det inte efterfrågas). Du delar minne och kunskapsbank " +
  "med Simba i Excel, Outlook och webben. För kalkylarksredigering, dokumentskapande och djupare analys: " +
  "hänvisa till Simba-appen. Grunda svar om företaget i kunskapsbanken när kontext finns.";
