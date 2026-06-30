/*
 * Optional semantic embeddings for the knowledge vault (vector search).
 *
 * Uses Voyage AI (Anthropic's recommended embedding provider). Enabled only when
 * VOYAGE_API_KEY is set — otherwise the vault gracefully falls back to keyword
 * search. Vectors are stored per entry and compared with cosine similarity.
 */
const KEY = process.env.VOYAGE_API_KEY || "";
const MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";
export const vectorEnabled = Boolean(KEY);

// Embed one or more texts. `inputType` is "document" (stored entries) or "query".
// Returns an array of number[] vectors, or null if embeddings aren't configured.
export async function embed(texts, inputType = "document") {
  if (!KEY) return null;
  const input = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || "").slice(0, 8000));
  if (!input.length) return [];
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input, model: MODEL, input_type: inputType }),
  });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 200);
    throw Object.assign(new Error(`Voyage embeddings failed (${r.status}). ${detail}`), { status: r.status });
  }
  const j = await r.json();
  return (j.data || []).map((d) => d.embedding);
}

export async function embedOne(text, inputType = "document") {
  const v = await embed([text], inputType);
  return v && v[0] ? v[0] : null;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
