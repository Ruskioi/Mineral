/*
 * Auto-memory — after a completed turn, the fast model quietly checks whether
 * the exchange revealed a DURABLE fact about the user (role, preferences,
 * recurring context) and, if so, appends it to their memory notes. The user
 * never has to say "kom ihåg det här" — but stays in control: the notes are
 * visible/editable under Inställningar → Minne, and a toggle turns this off.
 *
 * Guard rails: throttled per user, at most 2 new notes per run, near-duplicate
 * notes are dropped, and the extractor is told to output NOTHING for chit-chat
 * or one-off task details. Runs in the background — never delays the reply.
 */
import { getMemory, setMemory } from "./store.js";

const THROTTLE_MS = 10 * 60_000; // at most one extraction per user per 10 min
const MAX_NOTES = 50;
const lastRun = new Map(); // userKey -> ts

const EXTRACT_SYSTEM =
  "Du underhåller ett långtidsminne om en användare. Ur utbytet nedan: extrahera 0–2 NYA varaktiga fakta om " +
  "ANVÄNDAREN som är värda att minnas i månader (roll, företag, arbetssätt, preferenser, återkommande system/projekt). " +
  'Svara ENBART med en JSON-lista av korta svenska strängar, t.ex. ["Arbetar som ekonomichef på Mineral AB"]. ' +
  "Regler: bara sådant användaren själv uttryckt eller tydligt visat; INTE engångsdetaljer, artighetsfraser, " +
  "siffervärden från en enskild fråga eller något som redan står i de befintliga anteckningarna. Osäker? Svara [].";

const norm = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
function isDuplicate(note, existing) {
  const n = norm(note);
  if (!n) return true;
  return existing.some((e) => {
    const x = norm(e);
    return x === n || x.includes(n) || n.includes(x);
  });
}

export async function distillMemory(client, model, userKey, userText, assistantText) {
  const now = Date.now();
  if (!userKey || !String(userText || "").trim()) return;
  if (now - (lastRun.get(userKey) || 0) < THROTTLE_MS) return;
  lastRun.set(userKey, now);
  if (lastRun.size > 20000) lastRun.clear(); // crude memory cap

  const existing = (await getMemory(userKey).catch(() => [])) || [];
  const content =
    `BEFINTLIGA ANTECKNINGAR:\n${existing.length ? existing.map((n) => `- ${n}`).join("\n") : "(inga)"}\n\n` +
    `ANVÄNDAREN SKREV:\n${String(userText).slice(0, 1500)}\n\n` +
    `ASSISTENTEN SVARADE (utdrag):\n${String(assistantText || "").slice(0, 1000)}`;
  const resp = await client.messages.create({ model, max_tokens: 300, system: EXTRACT_SYSTEM, messages: [{ role: "user", content }] });
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let notes = [];
  try { const m = text.match(/\[[\s\S]*\]/); if (m) notes = JSON.parse(m[0]); } catch { return; }
  if (!Array.isArray(notes)) return;
  const fresh = notes
    .map((n) => String(n || "").trim().slice(0, 160))
    .filter((n) => n && !isDuplicate(n, existing))
    .slice(0, 2);
  if (!fresh.length) return;
  await setMemory(userKey, [...existing, ...fresh].slice(0, MAX_NOTES));
  console.log(`[Simba] auto-memory: +${fresh.length} note(s) for ${userKey.slice(0, 20)}…`);
}
