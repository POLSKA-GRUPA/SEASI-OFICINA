/** HARD suite: signed updater — real ed25519 keys, forgeries, downgrades. */
import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  FeedManifestSchema,
  canonicalJson,
  checkForUpdate,
  compareVersions,
  sha256,
  signManifest,
  verifyArtifact,
  verifyManifestSignature,
  type FeedManifest,
  type Fetcher,
} from "../src/domains/update/updater";

let privateKeyPem: string;
let publicKeyPem: string;
let attackerPrivateKeyPem: string;

beforeAll(() => {
  const good = generateKeyPairSync("ed25519");
  const bad = generateKeyPairSync("ed25519");
  privateKeyPem = good.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  publicKeyPem = good.publicKey.export({ type: "spki", format: "pem" }).toString();
  attackerPrivateKeyPem = bad.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

function manifest(overrides: Partial<FeedManifest> = {}): FeedManifest {
  return FeedManifestSchema.parse({
    channel: "pgk-internal",
    version: "0.2.0",
    createdAt: "2026-08-17T16:00:00.000Z",
    files: [{ name: "app.dmg", sha256: "a".repeat(64), size: 10 }],
    ...overrides,
  });
}

function fetcherWith(feed: unknown): Fetcher {
  return async () => ({ ok: true, body: async () => JSON.stringify(feed) });
}

const args = (fetcher: Fetcher, extra: Partial<Parameters<typeof checkForUpdate>[0]> = {}) => ({
  feedUrl: "https://feed.privado/feed.json",
  currentVersion: "0.1.0",
  channel: "pgk-internal",
  publicKeyPem,
  fetcher,
  ...extra,
});

describe("canonicalJson", () => {
  it("estable con keys desordenadas y whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }))
      .toBe(canonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  });
});

describe("signature verification", () => {
  it("firma válida verifica; whitespace no rompe", () => {
    const m = manifest();
    const sig = signManifest(m, privateKeyPem);
    expect(verifyManifestSignature(JSON.stringify(m), sig, publicKeyPem)).toBe(true);
    expect(
      verifyManifestSignature(JSON.stringify(m, null, 4), sig, publicKeyPem),
    ).toBe(true);
  });

  it("FORJAS: otra clave, contenido mutado, signature corrupta", () => {
    const m = manifest();
    const goodSig = signManifest(m, privateKeyPem);
    const attackerSig = signManifest(m, attackerPrivateKeyPem);
    expect(verifyManifestSignature(JSON.stringify(m), attackerSig, publicKeyPem)).toBe(false);

    const mutated = { ...m, version: "9.9.9" };
    expect(verifyManifestSignature(JSON.stringify(mutated), goodSig, publicKeyPem)).toBe(false);
    expect(verifyManifestSignature(JSON.stringify(m), goodSig.slice(0, -4) + "AAAA", publicKeyPem)).toBe(false);
    expect(verifyManifestSignature(JSON.stringify(m), "no-base64!!!", publicKeyPem)).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("happy path devuelve plan con artefacto", async () => {
    const m = manifest();
    const feed = { manifest: m, signature: signManifest(m, privateKeyPem) };
    const plan = await checkForUpdate(args(fetcherWith(feed)));
    expect(plan?.manifest.version).toBe("0.2.0");
    expect(plan?.artifact.name).toBe("app.dmg");
  });

  it("feed injertado post-firma es rechazado", async () => {
    const m = manifest();
    const sig = signManifest(m, privateKeyPem);
    const tampered = { manifest: { ...m, files: [{ name: "malware", sha256: "f".repeat(64), size: 1 }] }, signature: sig };
    await expect(checkForUpdate(args(fetcherWith(tampered)))).rejects.toMatchObject({ reason: "signature-invalid" });
  });

  it("downgrade devuelve null (nunca instala)", async () => {
    const m = manifest({ version: "0.0.1" });
    const feed = { manifest: m, signature: signManifest(m, privateKeyPem) };
    const plan = await checkForUpdate(args(fetcherWith(feed), { currentVersion: "0.5.0" }));
    expect(plan).toBeNull();
  });

  it("canal equivocado se rechaza aunque la firma sea buena", async () => {
    const m = manifest({ channel: "rival-despacho" });
    const feed = { manifest: m, signature: signManifest(m, privateKeyPem) };
    await expect(checkForUpdate(args(fetcherWith(feed)))).rejects.toMatchObject({ reason: "wrong-channel" });
  });

  it("manifest fuera de schema se rechaza", async () => {
    const m = { ...manifest(), files: [{ name: "x", sha256: "corto", size: -1 }] };
    const feed = { manifest: m, signature: "AAAA" };
    await expect(checkForUpdate(args(fetcherWith(feed)))).rejects.toMatchObject({ reason: "manifest-invalid" });
  });

  it("feed inalcanzable es error tipado", async () => {
    const failing: Fetcher = async () => { throw new Error("dns roto"); };
    await expect(checkForUpdate(args(failing))).rejects.toMatchObject({ reason: "feed-unreachable" });
  });

  it("JSON no válido → manifest-invalid", async () => {
    const garbage: Fetcher = async () => ({ ok: true, body: async () => "<html>no json</html>" });
    await expect(checkForUpdate(args(garbage))).rejects.toMatchObject({ reason: "manifest-invalid" });
  });
});

describe("verifyArtifact", () => {
  it("bytes correctos pasan; un byte mutado mata", () => {
    const bytes = Buffer.from("0123456789");
    const m = manifest({ files: [{ name: "app.dmg", sha256: sha256(bytes), size: bytes.byteLength }] });
    const plan = { manifest: m, artifact: m.files[0]! };
    verifyArtifact(plan, bytes);
    const evil = Buffer.from(bytes);
    evil[9] = 88;
    expect(() => verifyArtifact(plan, evil)).toThrow(/sha256/);
    // mismatch solo de tamaño: sha real correcta pero declarada mentirosa
    const lying = { manifest: m, artifact: { ...m.files[0]!, size: bytes.byteLength + 1 } };
    expect(() => verifyArtifact(lying, bytes)).toThrow(/tamaño/);
  });
});

describe("compareVersions", () => {
  it("semver simple", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
    expect(compareVersions("2.1.3", "2.1.3")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
  });
});
