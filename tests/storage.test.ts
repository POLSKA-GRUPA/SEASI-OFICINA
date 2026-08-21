import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLineDurableSync,
  durableWriteTempPath,
  writeFileDurableSync,
} from "../src/domains/storage/durable-file-write";
import {
  BoundedFileTooLargeError,
  JsonStructureLimitError,
  assertJsonStructureWithinLimits,
  readFileBoundedSync,
  readJsonFileBoundedSync,
} from "../src/domains/storage/bounded-json-file";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seasi-storage-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileDurableSync", () => {
  it("escribe el contenido y no deja temporales", () => {
    const file = join(dir, "estado.json");
    writeFileDurableSync(file, '{"a":1}');
    expect(readFileSync(file, "utf8")).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(["estado.json"]);
  });

  it("reemplaza atómicamente el contenido anterior", () => {
    const file = join(dir, "estado.json");
    writeFileDurableSync(file, "viejo");
    writeFileDurableSync(file, "nuevo");
    expect(readFileSync(file, "utf8")).toBe("nuevo");
    expect(readdirSync(dir)).toEqual(["estado.json"]);
  });

  it("durableWriteTempPath genera rutas únicas junto al destino", () => {
    const file = join(dir, "x.json");
    const a = durableWriteTempPath(file);
    const b = durableWriteTempPath(file);
    expect(a).not.toBe(b);
    expect(a.startsWith(file + ".")).toBe(true);
    expect(a.endsWith(".tmp")).toBe(true);
  });
});

describe("appendLineDurableSync", () => {
  it("añade líneas preservando las anteriores", () => {
    const file = join(dir, "log.jsonl");
    appendLineDurableSync(file, "uno\n");
    appendLineDurableSync(file, "dos\n");
    expect(readFileSync(file, "utf8")).toBe("uno\ndos\n");
  });
});

describe("readFileBoundedSync", () => {
  it("lee un fichero dentro del límite", () => {
    const file = join(dir, "peq.txt");
    writeFileSync(file, "hola");
    expect(readFileBoundedSync(file, 1024).toString("utf8")).toBe("hola");
  });

  it("rechaza ficheros que superan el límite ANTES de cargarlos", () => {
    const file = join(dir, "gordo.txt");
    writeFileSync(file, "x".repeat(2048));
    expect(() => readFileBoundedSync(file, 1024)).toThrow(BoundedFileTooLargeError);
  });

  it("rechaza límites inválidos", () => {
    expect(() => readFileBoundedSync(join(dir, "n"), -1)).toThrow(RangeError);
  });
});

describe("assertJsonStructureWithinLimits", () => {
  it("acepta JSON normal", () => {
    expect(() =>
      assertJsonStructureWithinLimits('{"a":[1,2,{"b":"c"}]}', { structuralTokens: 100, nestingDepth: 10 }),
    ).not.toThrow();
  });

  it("rechaza anidamiento excesivo", () => {
    const deep = "[".repeat(20) + "]".repeat(20);
    expect(() => assertJsonStructureWithinLimits(deep, { structuralTokens: 1000, nestingDepth: 10 })).toThrow(
      JsonStructureLimitError,
    );
  });

  it("rechaza exceso de tokens estructurales", () => {
    const wide = `[${"1,".repeat(50)}1]`;
    expect(() => assertJsonStructureWithinLimits(wide, { structuralTokens: 10, nestingDepth: 10 })).toThrow(
      JsonStructureLimitError,
    );
  });

  it("las llaves dentro de strings no cuentan como estructura", () => {
    expect(() =>
      assertJsonStructureWithinLimits('{"a":"{{{{[[[["}', { structuralTokens: 5, nestingDepth: 2 }),
    ).not.toThrow();
  });
});

describe("readJsonFileBoundedSync", () => {
  it("parsea JSON válido", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, '{"origin":"mc-12345678"}');
    expect(readJsonFileBoundedSync(file)).toEqual({ origin: "mc-12345678" });
  });

  it("propaga el límite de bytes", () => {
    const file = join(dir, "grande.json");
    writeFileSync(file, `{"x":"${"y".repeat(200)}"}`);
    expect(() => readJsonFileBoundedSync(file, 100)).toThrow(BoundedFileTooLargeError);
  });
});
