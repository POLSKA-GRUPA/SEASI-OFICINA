/**
 * Quick Open: emparejado difuso puro para la paleta global.
 * Solo presentación — no toca kernel, ledger ni IPC.
 */

export type PaletteEntry = {
  id: string;
  kind: "view" | "session" | "action";
  title: string;
  subtitle?: string;
  keywords?: string;
};

/**
 * Puntuación por subsecuencia: cada carácter de la consulta debe aparecer
 * en orden. Bonifica coincidencias contiguas y en inicio de palabra;
 * penaliza los huecos. Devuelve null si la consulta no es subsecuencia.
 */
export function scoreMatch(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  let score = 0;
  let ti = 0;
  let prevHit = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    if (found === prevHit + 1) score += 8; // contiguo
    else score += 1;
    const before = found === 0 ? " " : t[found - 1] ?? " ";
    if (before === " " || before === "-" || before === "_" || before === "·" || before === "/") score += 6;
    score -= Math.min(found - ti, 10) * 0.5; // hueco
    prevHit = found;
    ti = found + 1;
  }
  score -= (t.length - q.length) * 0.05; // ligera preferencia por textos cortos
  return score;
}

export function filterPalette(entries: PaletteEntry[], query: string, limit = 8): PaletteEntry[] {
  const trimmed = query.trim();
  if (trimmed === "") return entries.slice(0, limit);
  const scored: { entry: PaletteEntry; score: number }[] = [];
  for (const entry of entries) {
    const haystack = `${entry.title} ${entry.subtitle ?? ""} ${entry.keywords ?? ""}`;
    const score = scoreMatch(trimmed, haystack);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}
