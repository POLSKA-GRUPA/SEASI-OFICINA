import { describe, expect, it } from "vitest";
import {
  composeFollowUp,
  createNote,
  markPendingSent,
  parseStoredNotes,
  pendingNotes,
  removeNote,
  type ReviewNote,
} from "../src/domains/review/notes";

const note = (id: number, text: string, sentAt: string | null = null): ReviewNote => ({
  ...createNote({
    id,
    itemId: id * 10,
    itemLabel: `acard tool-${id}`,
    quote: `línea ${id}`,
    text,
    createdAt: "2026-08-20T01:00:00Z",
  }),
  sentAt,
});

describe("review notes", () => {
  it("createNote nace pendiente (sentAt null)", () => {
    expect(note(1, "x").sentAt).toBeNull();
  });

  it("pendingNotes filtra las ya enviadas", () => {
    const notes = [note(1, "a"), note(2, "b", "2026-08-20T02:00:00Z"), note(3, "c")];
    expect(pendingNotes(notes).map((n) => n.id)).toEqual([1, 3]);
  });

  it("markPendingSent sella solo las pendientes", () => {
    const notes = [note(1, "a"), note(2, "b", "2026-08-20T02:00:00Z")];
    const sealed = markPendingSent(notes, "2026-08-20T03:00:00Z");
    expect(sealed[0]!.sentAt).toBe("2026-08-20T03:00:00Z");
    expect(sealed[1]!.sentAt).toBe("2026-08-20T02:00:00Z");
  });

  it("removeNote elimina por id", () => {
    expect(removeNote([note(1, "a"), note(2, "b")], 1).map((n) => n.id)).toEqual([2]);
  });

  it("composeFollowUp numera las pendientes con etiqueta y cita", () => {
    const out = composeFollowUp([note(1, "revisa el IVA"), note(2, "ya enviado", "2026-08-20T02:00:00Z"), note(3, "falta anexo")]);
    expect(out).toContain("estas 2 notas");
    expect(out).toContain("1. [acard tool-1] «línea 1»");
    expect(out).toContain("   revisa el IVA");
    expect(out).toContain("2. [acard tool-3] «línea 3»");
    expect(out).not.toContain("ya enviado");
  });

  it("composeFollowUp sin pendientes devuelve cadena vacía", () => {
    expect(composeFollowUp([note(1, "a", "2026-08-20T02:00:00Z")])).toBe("");
  });
});

describe("parseStoredNotes", () => {
  it("recupera notas válidas y descarta basura", () => {
    const good = note(1, "ok");
    const raw = JSON.stringify([good, { id: "no" }, 42]);
    expect(parseStoredNotes(raw)).toEqual([good]);
  });

  it("tolera null y JSON corrupto", () => {
    expect(parseStoredNotes(null)).toEqual([]);
    expect(parseStoredNotes("{corrupto")).toEqual([]);
    expect(parseStoredNotes("\"no-array\"")).toEqual([]);
  });
});
