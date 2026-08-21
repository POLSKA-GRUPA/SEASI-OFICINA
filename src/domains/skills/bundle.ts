/**
 * Bundles de skills versionadas por tenant, firmados con Ed25519 — sin cloud.
 * Un bundle es un directorio con:
 *   manifest.json  — nombre, versión, tenant y sha256 de cada archivo
 *   manifest.sig   — firma Ed25519 (base64) del manifest canónico
 * La verificación es local: clave pública PEM + hashes recomputados.
 */
import { createHash, sign, verify, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type SkillFileEntry = { path: string; sha256: string };

export type SkillManifest = {
  name: string;
  version: string;
  tenant_id: string;
  description: string;
  files: SkillFileEntry[];
};

export type VerifyResult = { ok: boolean; errors: string[] };

const MANIFEST_FILE = "manifest.json";
const SIGNATURE_FILE = "manifest.sig";

/** JSON canónico: claves en orden fijo y files ordenados por path. */
export function canonicalManifestJson(m: SkillManifest): string {
  const files = [...m.files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, sha256: f.sha256 }));
  return JSON.stringify({
    name: m.name,
    version: m.version,
    tenant_id: m.tenant_id,
    description: m.description,
    files,
  });
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function walkFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/** Construye el manifest hasheando todos los archivos del directorio. */
export function buildManifest(
  dir: string,
  meta: { name: string; version: string; tenant_id: string; description: string },
): SkillManifest {
  const files = walkFiles(dir, dir)
    .filter((p) => p !== MANIFEST_FILE && p !== SIGNATURE_FILE)
    .sort()
    .map((p) => ({ path: p, sha256: sha256Hex(readFileSync(join(dir, p))) }));
  return { ...meta, files };
}

export function signManifest(canonicalJson: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  return sign(null, Buffer.from(canonicalJson, "utf8"), key).toString("base64");
}

export function verifyManifestSignature(
  canonicalJson: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(canonicalJson, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function parseManifest(raw: string): SkillManifest | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const m = parsed as Record<string, unknown>;
    if (
      typeof m.name !== "string" || typeof m.version !== "string" ||
      typeof m.tenant_id !== "string" || typeof m.description !== "string" ||
      !Array.isArray(m.files)
    ) return null;
    const files: SkillFileEntry[] = [];
    for (const f of m.files) {
      const rec = f as Record<string, unknown>;
      if (typeof rec.path !== "string" || typeof rec.sha256 !== "string") return null;
      if (rec.path.includes("..") || rec.path.startsWith("/")) return null;
      files.push({ path: rec.path, sha256: rec.sha256 });
    }
    return { name: m.name, version: m.version, tenant_id: m.tenant_id, description: m.description, files };
  } catch {
    return null;
  }
}

/** Verifica firma + integridad de cada archivo del bundle en disco. */
export function verifySkillBundle(dir: string, publicKeyPem: string): VerifyResult {
  const errors: string[] = [];
  let manifestRaw: string;
  let signature: string;
  try {
    manifestRaw = readFileSync(join(dir, MANIFEST_FILE), "utf8");
  } catch {
    return { ok: false, errors: [`falta ${MANIFEST_FILE}`] };
  }
  try {
    signature = readFileSync(join(dir, SIGNATURE_FILE), "utf8").trim();
  } catch {
    return { ok: false, errors: [`falta ${SIGNATURE_FILE}`] };
  }
  const manifest = parseManifest(manifestRaw);
  if (!manifest) return { ok: false, errors: ["manifest.json inválido"] };

  if (!verifyManifestSignature(canonicalManifestJson(manifest), signature, publicKeyPem)) {
    errors.push("firma Ed25519 inválida para el manifest");
  }
  for (const f of manifest.files) {
    let data: Buffer;
    try {
      data = readFileSync(join(dir, f.path));
    } catch {
      errors.push(`archivo declarado ausente: ${f.path}`);
      continue;
    }
    const actual = sha256Hex(data);
    if (actual !== f.sha256) errors.push(`sha256 no coincide: ${f.path}`);
  }
  const declared = new Set(manifest.files.map((f) => f.path));
  for (const p of walkFiles(dir, dir)) {
    if (p !== MANIFEST_FILE && p !== SIGNATURE_FILE && !declared.has(p)) {
      errors.push(`archivo no declarado en el manifest: ${p}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
