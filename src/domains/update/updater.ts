/**
 * Signed update channel — ed25519 manifests, anti-downgrade, no auto-run.
 *
 * Feed format (JSON published on the private channel):
 * {
 *   "channel": "pgk-internal",
 *   "version": "0.2.0",
 *   "createdAt": "2026-08-17T16:00:00Z",
 *   "files": [{ "name": "La-Oficina-0.2.0.dmg", "sha256": "...", "size": 123 }]
 * }
 * + detached signature (base64) over the canonical JSON.
 *
 * The app embeds the PUBLIC key; each package must also verify its sha256
 * after download. Downgrades are refused. Nothing executes without an
 * explicit user action (apply is a separate, guarded step).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";

export const FeedManifestSchema = z
  .object({
    channel: z.string().min(1).max(64),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    createdAt: z.string().min(1),
    files: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          size: z.number().int().positive(),
        }),
      )
      .min(1),
  })
  .strict();

export type FeedManifest = z.infer<typeof FeedManifestSchema>;

export const sha256 = (data: Buffer | string): string =>
  createHash("sha256").update(data).digest("hex");

/** Stable canonical JSON: sorted keys, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, val]) => val !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const obj: Record<string, unknown> = {};
      for (const [k, val] of entries) obj[k] = walk(val);
      return obj;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export function signManifest(
  manifest: FeedManifest,
  privateKeyPem: string,
): string {
  const key = createPrivateKey(privateKeyPem);
  return edSign(null, Buffer.from(canonicalJson(manifest), "utf8"), key).toString("base64");
}

export type Fetcher = (url: string) => Promise<{ ok: boolean; body: () => Promise<string> }>;

export class UpdateError extends Error {
  constructor(readonly reason: UpdateFailureReason, message: string) {
    super(message);
    this.name = "UpdateError";
  }
}

export type UpdateFailureReason =
  | "feed-unreachable"
  | "manifest-invalid"
  | "signature-invalid"
  | "downgrade"
  | "hash-mismatch"
  | "wrong-channel";

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number) as [number, number, number];
  const pb = b.split(".").map(Number) as [number, number, number];
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
  }
  return 0;
}

export function verifyManifestSignature(
  manifestJson: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  const key: KeyObject = createPublicKey(publicKeyPem);
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64, "base64");
  } catch {
    return false;
  }
  // Verify over the canonical re-serialization to kill whitespace tricks.
  const parsed = JSON.parse(manifestJson) as unknown;
  return edVerify(null, Buffer.from(canonicalJson(parsed), "utf8"), key, sig);
}

export type UpdatePlan = {
  manifest: FeedManifest;
  artifact: { name: string; sha256: string; size: number };
};

export async function checkForUpdate(args: {
  feedUrl: string;
  currentVersion: string;
  channel: string;
  publicKeyPem: string;
  fetcher: Fetcher;
}): Promise<UpdatePlan | null> {
  let bodyText: string;
  try {
    const res = await args.fetcher(args.feedUrl);
    if (!res.ok) throw new Error(`http ${res.ok}`);
    bodyText = await res.body();
  } catch (err) {
    throw new UpdateError(
      "feed-unreachable",
      `no se pudo leer el feed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let feed: { manifest?: unknown; signature?: unknown };
  try {
    feed = JSON.parse(bodyText) as { manifest?: unknown; signature?: unknown };
  } catch {
    throw new UpdateError("manifest-invalid", "feed no es JSON");
  }
  if (typeof feed.manifest !== "object" || feed.manifest === null) {
    throw new UpdateError("manifest-invalid", "feed sin manifest");
  }
  if (typeof feed.signature !== "string") {
    throw new UpdateError("manifest-invalid", "feed sin signature");
  }

  const parsed = FeedManifestSchema.safeParse(feed.manifest);
  if (!parsed.success) {
    throw new UpdateError("manifest-invalid", "manifest no valida el schema");
  }
  const manifest = parsed.data;

  if (manifest.channel !== args.channel) {
    throw new UpdateError("wrong-channel", `canal ${manifest.channel} ≠ ${args.channel}`);
  }

  let signatureOk = false;
  try {
    signatureOk = verifyManifestSignature(
      JSON.stringify(feed.manifest),
      feed.signature,
      args.publicKeyPem,
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    throw new UpdateError("signature-invalid", "firma del manifest inválida");
  }

  if (compareVersions(manifest.version, args.currentVersion) <= 0) {
    return null; // up to date (or feed older): no error, no downgrade
  }

  return { manifest, artifact: manifest.files[0]! };
}

/** Post-download gate: the artifact bytes must match the signed sha256. */
export function verifyArtifact(plan: UpdatePlan, bytes: Buffer): void {
  const actual = sha256(bytes);
  if (actual !== plan.artifact.sha256) {
    throw new UpdateError("hash-mismatch", `sha256 del artefacto no coincide: ${actual}`);
  }
  if (bytes.byteLength !== plan.artifact.size) {
    throw new UpdateError(
      "hash-mismatch",
      `tamaño ${bytes.byteLength} ≠ declarado ${plan.artifact.size}`,
    );
  }
}
