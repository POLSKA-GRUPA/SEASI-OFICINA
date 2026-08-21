/**
 * Lectura defensiva de ficheros de estado escritos fuera del control del
 * shell (tenant.json editado a mano, sidecars, estado dejado por agentes):
 * límite de bytes ANTES de cargar a memoria y límites estructurales del
 * JSON (tokens/anidamiento) ANTES de JSON.parse, para que un fichero
 * corrupto o hostil no tumbe el proceso main.
 *
 * Adaptado de stablyai/orca (src/shared/node-bounded-file-reader.ts y
 * src/shared/json-text-structure-limit.ts, MIT).
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export class BoundedFileTooLargeError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number,
  ) {
    super(`fichero demasiado grande: ${observedBytes} bytes supera el límite de ${maxBytes}`);
    this.name = "BoundedFileTooLargeError";
  }
}

export class JsonStructureLimitError extends Error {
  constructor(
    readonly resource: "structuralTokens" | "nestingDepth",
    readonly limit: number,
  ) {
    super(
      resource === "structuralTokens"
        ? `estructura JSON supera ${limit} tokens`
        : `anidamiento JSON supera ${limit} niveles`,
    );
    this.name = "JsonStructureLimitError";
  }
}

const MIN_GROWTH_BYTES = 64 * 1024;

/** Lee un fichero completo con techo de bytes (falla antes de reservar memoria). */
export function readFileBoundedSync(filePath: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("el límite de lectura debe ser un entero seguro no negativo");
  }
  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("tamaño de fichero inválido");
    if (size > maxBytes) throw new BoundedFileTooLargeError(size, maxBytes);

    let buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    for (;;) {
      while (offset < buffer.length) {
        const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) return buffer.subarray(0, offset);
        offset += bytesRead;
      }
      // el fichero pudo crecer durante la lectura: sondear un byte más
      const probe = Buffer.allocUnsafe(1);
      const bytesRead = readSync(fd, probe, 0, 1, offset);
      if (bytesRead === 0) return buffer.subarray(0, offset);
      if (offset >= maxBytes) throw new BoundedFileTooLargeError(offset + bytesRead, maxBytes);
      const nextCapacity = Math.min(maxBytes, Math.max(MIN_GROWTH_BYTES, buffer.length * 2, offset + bytesRead));
      const expanded = Buffer.allocUnsafe(nextCapacity);
      buffer.copy(expanded, 0, 0, offset);
      expanded[offset] = probe[0]!;
      buffer = expanded;
      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
}

export type JsonStructureLimits = Readonly<{ structuralTokens: number; nestingDepth: number }>;

/** Verifica límites estructurales de un texto JSON sin parsearlo. */
export function assertJsonStructureWithinLimits(content: string, limits: JsonStructureLimits): void {
  for (const value of [limits.structuralTokens, limits.nestingDepth]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError("los límites estructurales deben ser enteros seguros no negativos");
    }
  }
  let structuralTokens = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (
      character !== "{" && character !== "}" &&
      character !== "[" && character !== "]" &&
      character !== "," && character !== ":"
    ) {
      continue;
    }
    structuralTokens += 1;
    if (structuralTokens > limits.structuralTokens) {
      throw new JsonStructureLimitError("structuralTokens", limits.structuralTokens);
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > limits.nestingDepth) throw new JsonStructureLimitError("nestingDepth", limits.nestingDepth);
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
}

export const MAX_STATE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_STATE_JSON_STRUCTURAL_TOKENS = 1_000_000;
export const MAX_STATE_JSON_NESTING_DEPTH = 128;

/** Lee y parsea un JSON de estado con todos los límites por defecto. */
export function readJsonFileBoundedSync(filePath: string, maxBytes: number = MAX_STATE_FILE_BYTES): unknown {
  const content = readFileBoundedSync(filePath, maxBytes).toString("utf8");
  assertJsonStructureWithinLimits(content, {
    structuralTokens: MAX_STATE_JSON_STRUCTURAL_TOKENS,
    nestingDepth: MAX_STATE_JSON_NESTING_DEPTH,
  });
  return JSON.parse(content) as unknown;
}
