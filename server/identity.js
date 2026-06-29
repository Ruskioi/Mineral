/*
 * Microsoft 365 identity verification for Simba.
 *
 * The task pane gets an Office SSO bootstrap token via OfficeRuntime.auth
 * .getAccessToken() and sends it as `Authorization: Bearer <token>`. Here we
 * verify that token's signature against Microsoft's public keys and confirm it
 * was issued for THIS app, then return a stable per-user key.
 *
 * SSO is opt-in: if AAD_CLIENT_ID is not set, verification is disabled and the
 * client falls back to device-local memory.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const AAD_CLIENT_ID = process.env.AAD_CLIENT_ID || process.env.SIMBA_AAD_CLIENT_ID || "";
const AAD_TENANT = process.env.AAD_TENANT || ""; // optional: pin to one tenant GUID
export const ssoConfigured = Boolean(AAD_CLIENT_ID);

// Microsoft signs both v1 and v2 tokens; try the v2 keyset first, then v1.
const JWKS_V2 = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));
const JWKS_V1 = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/keys"));

const ISSUER_RE = /^https:\/\/(login\.microsoftonline\.com\/[0-9a-f-]+\/v2\.0|sts\.windows\.net\/[0-9a-f-]+\/?)$/i;

function audienceMatches(aud) {
  const list = Array.isArray(aud) ? aud : [aud];
  return list.some((a) => a === AAD_CLIENT_ID || (typeof a === "string" && a.endsWith(`/${AAD_CLIENT_ID}`)));
}

async function verifyWith(jwks, token) {
  const { payload } = await jwtVerify(token, jwks, { clockTolerance: 60 });
  return payload;
}

/**
 * Verify an Office SSO bootstrap token. Returns a user object on success or
 * throws. The signature check (against Microsoft's JWKS) is the security-
 * critical step; we then confirm the audience is our app and the issuer is AAD.
 */
export async function verifyToken(token) {
  if (!ssoConfigured) throw Object.assign(new Error("SSO is not configured on the server."), { status: 501 });
  if (!token) throw Object.assign(new Error("Missing bearer token."), { status: 401 });

  let payload;
  try {
    payload = await verifyWith(JWKS_V2, token);
  } catch {
    payload = await verifyWith(JWKS_V1, token); // v1 bootstrap tokens (sts.windows.net)
  }

  if (!audienceMatches(payload.aud))
    throw Object.assign(new Error("Token audience does not match this app."), { status: 401 });
  if (typeof payload.iss !== "string" || !ISSUER_RE.test(payload.iss))
    throw Object.assign(new Error("Token issuer is not Microsoft Entra ID."), { status: 401 });

  // Require the delegated scope this app exposes — a token minted for a
  // different permission shouldn't be accepted.
  const scopes = String(payload.scp || "").split(/\s+/).filter(Boolean);
  if (!scopes.includes("access_as_user"))
    throw Object.assign(new Error("Token is missing the access_as_user scope."), { status: 401 });

  const oid = payload.oid || payload.sub;
  const tid = payload.tid; // do not default — a token without a tenant is rejected
  if (!oid) throw Object.assign(new Error("Token has no stable user id."), { status: 401 });
  if (!tid) throw Object.assign(new Error("Token has no tenant id."), { status: 401 });
  if (AAD_TENANT && tid !== AAD_TENANT)
    throw Object.assign(new Error("Token tenant is not allowed."), { status: 401 });

  return {
    key: `${tid}:${oid}`, // stable, globally-unique per user
    name: payload.name || payload.preferred_username || "",
    email: payload.preferred_username || payload.upn || "",
  };
}

/** Pull a bearer token out of the Authorization header. */
export function bearer(req) {
  const h = req.headers?.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}
