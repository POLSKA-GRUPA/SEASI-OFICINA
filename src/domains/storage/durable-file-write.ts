/**
 * Escritura durable de ficheros de estado (vault, tenant.json, sidecars,
 * ledger JSONL). rename() es atómico para lectores pero NO durable: sin
 * fsync del fichero y de su directorio, un corte de luz tras el rename
 * puede dejar el contenido viejo o un inode vacío.
 *
 * Patrón: temp file → write → fsync → rename → fsync(dir).
 * Adaptado de stablyai/orca (src/main/durable-file-write.ts, MIT).
 */
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * fsync de un directorio para que un rename dentro de él sea durable.
 * Best-effort: Windows no permite abrir directorios para fsync y algunos
 * filesystems lo rechazan; el fsync del fichero es la parte crítica.
 */
function syncDirectorySync(directory: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // esperado en Windows y filesystems sin fsync de directorio
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // el fsync ya ocurrió o el open falló; nada accionable
      }
    }
  }
}

/** Ruta temporal única junto al destino (mismo filesystem ⇒ rename atómico). */
export function durableWriteTempPath(finalPath: string): string {
  return `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

/** Escribe `payload` de forma durable en `finalPath` (temp+fsync+rename+fsync dir). */
export function writeFileDurableSync(finalPath: string, payload: string, mode?: number): void {
  const tmpPath = durableWriteTempPath(finalPath);
  let renamed = false;
  try {
    writeFileSync(tmpPath, payload, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
    const fd = openSync(tmpPath, "r+");
    try {
      // fsync ANTES del rename: un rename que aterriza primero puede exponer un fichero vacío
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, finalPath);
    renamed = true;
    syncDirectorySync(dirname(finalPath));
  } finally {
    if (!renamed) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // el temp huérfano no bloquea nada; se limpia en el siguiente arranque
      }
    }
  }
}

/**
 * Append durable de una línea a un log JSONL: write + fsync en el mismo
 * descriptor. El log es append-only, así que aquí no hay rename; lo que
 * importa es que la línea esté en disco antes de confiar en ella.
 */
export function appendLineDurableSync(filePath: string, line: string): void {
  const fd = openSync(filePath, "a", 0o600);
  try {
    writeSync(fd, line, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
