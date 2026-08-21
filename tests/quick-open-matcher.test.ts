import { describe, expect, it } from "vitest";
import { filterPalette, scoreMatch, type PaletteEntry } from "../src/domains/quick-open/matcher";

const entry = (id: string, title: string, subtitle?: string, keywords?: string): PaletteEntry => ({
  id,
  kind: "view",
  title,
  ...(subtitle !== undefined ? { subtitle } : {}),
  ...(keywords !== undefined ? { keywords } : {}),
});

describe("scoreMatch", () => {
  it("consulta vacía empareja con puntuación neutra", () => {
    expect(scoreMatch("", "lo que sea")).toBe(0);
  });

  it("devuelve null si la consulta no es subsecuencia", () => {
    expect(scoreMatch("xyz", "vault")).toBeNull();
    expect(scoreMatch("tluav", "vault")).toBeNull();
  });

  it("es insensible a mayúsculas", () => {
    expect(scoreMatch("VAU", "Vault")).not.toBeNull();
  });

  it("prefiere coincidencias contiguas y en inicio de palabra", () => {
    const contiguous = scoreMatch("uso", "Uso");
    const scattered = scoreMatch("uso", "un salto obvio");
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(contiguous!).toBeGreaterThan(scattered!);
  });
});

describe("filterPalette", () => {
  const entries = [
    entry("chat", "Chat", "vista"),
    entry("uso", "Uso", "vista"),
    entry("vault", "Vault", "vista", "secretos"),
    entry("s1", "B82211806", "2026T3 · pi"),
    entry("s2", "A11111111", "2026T2 · pi"),
  ];

  it("sin consulta devuelve las primeras hasta el límite", () => {
    expect(filterPalette(entries, "", 3).map((e) => e.id)).toEqual(["chat", "uso", "vault"]);
  });

  it("filtra por título", () => {
    expect(filterPalette(entries, "b822").map((e) => e.id)).toEqual(["s1"]);
  });

  it("empareja por subtítulo y keywords", () => {
    expect(filterPalette(entries, "2026t2").map((e) => e.id)).toEqual(["s2"]);
    expect(filterPalette(entries, "secretos").map((e) => e.id)).toEqual(["vault"]);
  });

  it("ordena por relevancia y respeta el límite", () => {
    const res = filterPalette(entries, "u", 2);
    expect(res.length).toBe(2);
    expect(res[0]!.id).toBe("uso");
  });

  it("descarta lo que no empareja", () => {
    expect(filterPalette(entries, "zzz")).toEqual([]);
  });
});
