/*
 * Model router: pick the cheaper/faster model for simple, conversational turns
 * and keep the strong model for real work (sheet edits, tool use, attachments,
 * longer/complex prompts). Pure functions so it can be unit-tested.
 */

// Words that signal the user wants real work — those turns stay on the strong model.
export const ACTION_RE = new RegExp(
  [
    "skapa", "bygg", "gör en", "skriv", "redigera", "ändra", "fyll", "lägg till", "ta bort", "infoga",
    "formel", "formler", "summ", "räkna", "beräkna", "medel", "diagram", "graf", "formatera", "format",
    "sortera", "filtrera", "färg", "kolumn", "rad ", "rader", "cell", "pivot", "tabell", "importera",
    "analys", "analysera", "prognos", "trend", "avvikels", "schemalägg", "schema", "dokument",
    "powerpoint", "word", "pdf", "presentation", "rapport", "kör kod", "macro", "makro",
    "create", "build", "write a formula", "edit", "chart", "analyze", "schedule", "document",
  ].join("|"),
  "i"
);

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}

/**
 * Decide the model for a turn.
 * @returns the simple model only for clearly-simple conversational turns.
 */
export function chooseModel(messages, speed, { strong, simple, on = true }) {
  if (!on) return strong;
  if (speed === "thorough") return strong;          // user asked for max quality
  const last = messages[messages.length - 1];
  if (!last) return strong;
  // Mid agent loop (answering tool results) or a turn carrying files → strong.
  if (Array.isArray(last.content) && last.content.some((b) => b && (b.type === "tool_result" || b.type === "image" || b.type === "document"))) return strong;
  const text = lastUserText(messages);
  if (!text) return strong;
  if (text.length > 500) return strong;             // long / likely complex
  if (/\[Aktuell markering:/.test(text)) return strong; // actively working on a selection
  if (ACTION_RE.test(text)) return strong;          // wants real work / tools
  return simple;                                      // plain question → cheaper model
}
