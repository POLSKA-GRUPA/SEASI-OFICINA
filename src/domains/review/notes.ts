/**
 * Notas de revisión humana sobre el resultado de un agente.
 * Proyección local de presentación: las notas viven en el renderer
 * (localStorage) hasta que se envían como follow-up por el canal de
 * negocio normal (seasi.session.run) — nunca como segunda autoridad.
 */

export type ReviewNote = {
  id: number;
  itemId: number;
  itemLabel: string;
  quote: string;
  text: string;
  createdAt: string;
  sentAt: string | null;
};

export function createNote(p: {
  id: number;
  itemId: number;
  itemLabel: string;
  quote: string;
  text: string;
  createdAt: string;
}): ReviewNote {
  return { ...p, sentAt: null };
}

export function pendingNotes(notes: ReviewNote[]): ReviewNote[] {
  return notes.filter((n) => n.sentAt === null);
}

export function markPendingSent(notes: ReviewNote[], sentAt: string): ReviewNote[] {
  return notes.map((n) => (n.sentAt === null ? { ...n, sentAt } : n));
}

export function removeNote(notes: ReviewNote[], id: number): ReviewNote[] {
  return notes.filter((n) => n.id !== id);
}

/** Compone el follow-up batch con todas las notas pendientes. */
export function composeFollowUp(notes: ReviewNote[]): string {
  const pending = pendingNotes(notes);
  if (pending.length === 0) return "";
  const lines = [
    `Revisión humana del resultado — atiende estas ${pending.length} notas:`,
  ];
  pending.forEach((n, i) => {
    lines.push(`${i + 1}. [${n.itemLabel}]${n.quote ? ` «${n.quote}»` : ""}`);
    lines.push(`   ${n.text}`);
  });
  return lines.join("\n");
}

export function parseStoredNotes(raw: string | null): ReviewNote[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is ReviewNote => {
      const rec = n as Record<string, unknown>;
      return typeof rec.id === "number"
        && typeof rec.itemId === "number"
        && typeof rec.itemLabel === "string"
        && typeof rec.quote === "string"
        && typeof rec.text === "string"
        && typeof rec.createdAt === "string"
        && (rec.sentAt === null || typeof rec.sentAt === "string");
    });
  } catch {
    return [];
  }
}
