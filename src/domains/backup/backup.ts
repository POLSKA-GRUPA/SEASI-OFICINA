/**
 * Local backups with hash anchors: ledger db (+wal/+shm), brain/, tenant
 * config. The manifest of sha256 digests is what catches tail-truncation
 * the event chain alone cannot see (see kernel hard suite note).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { z } from "zod";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export const BackupManifestSchema = z.object({
  schema_version: z.literal("seasi.backup/v1"),
  created_at: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().positive(),
    }),
  ),
});

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

export class BackupError extends Error {
  constructor(readonly reason: "corrupt" | "missing" | "write", message: string) {
    super(message);
    this.name = "BackupError";
  }
}

function collectFiles(roots: { ledgerDb: string; brainDir: string; tenantConfig: string }): string[] {
  const files: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${roots.ledgerDb}${suffix}`;
    if (existsSync(p)) files.push(p);
  }
  if (existsSync(roots.brainDir)) {
    for (const entry of readdirSync(roots.brainDir)) {
      if (entry.endsWith(".md")) files.push(join(roots.brainDir, entry));
    }
  }
  if (existsSync(roots.tenantConfig)) files.push(roots.tenantConfig);
  return files;
}

export function createBackup(args: {
  backupsRoot: string;
  ledgerDb: string;
  brainDir: string;
  tenantConfig: string;
  nowIso: string;
  id: string;
}): BackupManifest {
  const destDir = join(args.backupsRoot, args.id);
  mkdirSync(destDir, { recursive: true });

  const entries: BackupManifest["files"] = [];
  for (const src of collectFiles(args)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(src);
    } catch (err) {
      throw new BackupError(
        "missing",
        `no se pudo leer ${src}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const flat = basename(src);
    copyFileSync(src, join(destDir, flat));
    entries.push({ path: flat, sha256: sha256(bytes), size: bytes.byteLength });
  }
  if (entries.length === 0) {
    throw new BackupError("missing", "nada que respaldar (¿primera ejecución?)");
  }
  const manifest: BackupManifest = {
    schema_version: "seasi.backup/v1",
    created_at: args.nowIso,
    files: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
  writeFileSync(
    join(destDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

export function verifyBackup(backupDir: string): BackupManifest {
  const manifestPath = join(backupDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new BackupError("missing", `manifest.json ausente en ${backupDir}`);
  }
  let manifest: BackupManifest;
  try {
    manifest = BackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (err) {
    throw new BackupError("corrupt", `manifest ilegible: ${String(err)}`);
  }
  for (const file of manifest.files) {
    const p = join(backupDir, file.path);
    if (!existsSync(p)) {
      throw new BackupError("missing", `archivo del backup ausente: ${file.path}`);
    }
    const bytes = readFileSync(p);
    if (sha256(bytes) !== file.sha256 || bytes.byteLength !== file.size) {
      throw new BackupError("corrupt", `hash/tamaño no coincide: ${file.path}`);
    }
  }
  return manifest;
}

export function restoreBackup(args: {
  backupDir: string;
  ledgerDb: string;
  brainDir: string;
  tenantConfig: string;
}): BackupManifest {
  const manifest = verifyBackup(args.backupDir);
  for (const file of manifest.files) {
    const src = join(args.backupDir, file.path);
    if (file.path === basename(args.tenantConfig)) {
      copyFileSync(src, args.tenantConfig);
    } else if (file.path === basename(args.ledgerDb) ||
               file.path === `${basename(args.ledgerDb)}-wal` ||
               file.path === `${basename(args.ledgerDb)}-shm`) {
      copyFileSync(src, join(args.ledgerDb, "..", file.path));
    } else if (file.path.endsWith(".md")) {
      mkdirSync(args.brainDir, { recursive: true });
      copyFileSync(src, join(args.brainDir, file.path));
    }
  }
  return manifest;
}

export function listBackups(backupsRoot: string): string[] {
  if (!existsSync(backupsRoot)) return [];
  return readdirSync(backupsRoot).sort().reverse();
}
