import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  canonicalManifestJson,
  parseManifest,
  signManifest,
  verifyManifestSignature,
  verifySkillBundle,
} from "../src/domains/skills/bundle";

const keys = generateKeyPairSync("ed25519");
const privPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pubPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();

const META = { name: "cierre-trimestral", version: "1.2.0", tenant_id: "pgk", description: "skill de cierre" };

let dir: string;

function seedBundle(): void {
  writeFileSync(join(dir, "SKILL.md"), "# cierre trimestral\npasos...");
  mkdirSync(join(dir, "plantillas"));
  writeFileSync(join(dir, "plantillas", "modelo303.txt"), "plantilla 303");
  const manifest = buildManifest(dir, META);
  const canonical = canonicalManifestJson(manifest);
  writeFileSync(join(dir, "manifest.json"), canonical);
  writeFileSync(join(dir, "manifest.sig"), signManifest(canonical, privPem));
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "skill-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("skill bundle Ed25519", () => {
  it("roundtrip firmar → verificar pasa", () => {
    seedBundle();
    expect(verifySkillBundle(dir, pubPem)).toEqual({ ok: true, errors: [] });
  });

  it("canonicalManifestJson es estable ante orden de files", () => {
    const m = buildManifest(dir, META);
    const shuffled = { ...m, files: [...m.files].reverse() };
    expect(canonicalManifestJson(shuffled)).toBe(canonicalManifestJson(m));
  });

  it("detecta archivo manipulado tras la firma", () => {
    seedBundle();
    writeFileSync(join(dir, "SKILL.md"), "contenido alterado");
    const res = verifySkillBundle(dir, pubPem);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("sha256 no coincide: SKILL.md"))).toBe(true);
  });

  it("detecta manifest manipulado (firma inválida)", () => {
    seedBundle();
    const m = parseManifest(canonicalManifestJson(buildManifest(dir, META)))!;
    const tampered = { ...m, version: "9.9.9" };
    writeFileSync(join(dir, "manifest.json"), canonicalManifestJson(tampered));
    const res = verifySkillBundle(dir, pubPem);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("firma Ed25519 inválida"))).toBe(true);
  });

  it("detecta archivo extra no declarado", () => {
    seedBundle();
    writeFileSync(join(dir, "extra.txt"), "colado");
    const res = verifySkillBundle(dir, pubPem);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("no declarado en el manifest: extra.txt"))).toBe(true);
  });

  it("detecta archivo declarado ausente", () => {
    seedBundle();
    rmSync(join(dir, "plantillas", "modelo303.txt"));
    const res = verifySkillBundle(dir, pubPem);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("ausente: plantillas/modelo303.txt"))).toBe(true);
  });

  it("rechaza clave pública equivocada", () => {
    seedBundle();
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(verifySkillBundle(dir, other).ok).toBe(false);
  });

  it("verifyManifestSignature no lanza con PEM basura", () => {
    expect(verifyManifestSignature("{}", "AAAA", "no-es-pem")).toBe(false);
  });

  it("parseManifest rechaza paths con traversal", () => {
    const raw = JSON.stringify({ ...META, files: [{ path: "../fuera.txt", sha256: "00" }] });
    expect(parseManifest(raw)).toBeNull();
  });

  it("faltan manifest.json o manifest.sig", () => {
    expect(verifySkillBundle(dir, pubPem).errors[0]).toContain("falta manifest.json");
    writeFileSync(join(dir, "manifest.json"), "{}");
    expect(verifySkillBundle(dir, pubPem).errors[0]).toContain("falta manifest.sig");
  });
});
