/*
 * Ambient context ("läget just nu") — a small snapshot of the user's recent
 * inbox woven into each chat turn, so Simba knows what's going on without
 * being asked ("svara på mejlet från Anna" just works).
 *
 * Uses the user's own delegated Mail.Read consent (OBO), so it never sees
 * anything the user can't. Fails soft to "" (no consent / no mailbox / Graph
 * hiccup) and is cached per user for a few minutes — one Graph call per
 * conversation burst, not per turn, and the injected text stays byte-stable
 * within a tool loop so prompt caching keeps working.
 */
import { oboGraphToken, listMail, MAIL_SCOPE } from "./graph.js";

const TTL = 5 * 60_000;
const MAX_CHARS = 1500;
const cache = new Map(); // userKey -> { at, text }

export async function ambientContext(bootstrapToken, userKey) {
  if (!bootstrapToken || !userKey) return "";
  const hit = cache.get(userKey);
  if (hit && Date.now() - hit.at < TTL) return hit.text;
  let text = "";
  try {
    const gt = await oboGraphToken(bootstrapToken, MAIL_SCOPE);
    const mails = await listMail(gt, { folder: "inbox", top: 6 });
    if (mails.length) {
      const lines = mails.map((m) => {
        const when = String(m.received || "").slice(0, 16).replace("T", " ");
        const who = m.fromName || m.from || "okänd avsändare";
        const peek = String(m.preview || "").replace(/\s+/g, " ").slice(0, 90);
        return `- ${when} · ${who} · ${m.subject}${m.isRead ? "" : " (oläst)"}${peek ? ` — ${peek}` : ""}`;
      });
      text = `Senaste mejlen i användarens inkorg (nyast först):\n${lines.join("\n")}`.slice(0, MAX_CHARS);
    }
  } catch { /* no mail consent or transient Graph error — stay quiet */ }
  cache.set(userKey, { at: Date.now(), text });
  if (cache.size > 5000) cache.clear(); // crude memory cap
  return text;
}
