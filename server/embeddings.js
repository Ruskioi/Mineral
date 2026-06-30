/*
 * Optional semantic embeddings for the knowledge vault (vector search).
 *
 * Uses Voyage AI (Anthropic's recommended embedding provider). Enabled only when
 * VOYAGE_API_KEY is set — otherwise the vault gracefully falls back to keyword
 * search. Vectors are stored per entry and compared with cosine similarity.
 */
const KEY = process.env.VOYAGE_API_KEY || "";
const MODEL = process.env.VOYAGE_MODEL || "voyage-3.5";
const RERANK_MODEL = process.env.VOYAGE_RERANK_MODEL || "rerank-2.5";
export const vectorEnabled = Boolean(KEY);
export const rerankEnabled = Boolean(KEY);

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

// Split text into overlapping passages on natural boundaries. A long document
// embedded as one vector loses detail (the average "blurs" every topic together);
// chunking lets retrieval match — and return — the specific passage that answers
// the query. Breaks are preferred on paragraph, then line, then sentence ends.
export function chunkText(text, { size = 1100, overlap = 150, max = 50 } = {}) {
  const clean = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks = [];
  let i = 0;
  while (i < clean.length && chunks.length < max) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      const slice = clean.slice(i, end);
      const para = slice.lastIndexOf("\n\n");
      const nl = slice.lastIndexOf("\n");
      const dot = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
      const brk = para > size * 0.5 ? para : nl > size * 0.6 ? nl : dot > size * 0.5 ? dot + 1 : -1;
      if (brk > 0) end = i + brk;
    }
    const piece = clean.slice(i, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks;
}

// Cross-encoder reranking (Voyage). Given a query and candidate documents,
// returns [{ index, score }] sorted by relevance — far more precise than cosine
// for the final ordering because it reads query+document together. Null when
// unavailable or on any error, so callers keep their hybrid ordering.
export async function rerank(query, documents, topK) {
  if (!KEY || !query || !Array.isArray(documents) || !documents.length) return null;
  const docs = documents.map((d) => String(d || "").slice(0, 8000));
  try {
    const r = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: String(query).slice(0, 4000), documents: docs,
        model: RERANK_MODEL, top_k: topK || docs.length,
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.data || [])
      .map((d) => ({ index: d.index, score: d.relevance_score }))
      .sort((a, b) => b.score - a.score);
  } catch { return null; }
}
