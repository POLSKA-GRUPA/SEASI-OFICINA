#!/usr/bin/env node
/**
 * sign-update.mjs — build + sign the private update feed (fase interna).
 *
 *   node scripts/sign-update.mjs \
 *     --artifact dist/SEASI-Despacho-0.2.0.dmg \
 *     --version 0.2.0 --channel pgk-internal \
 *     --key keys/update-private.pem \
 *     --out dist/feed.json
 *
 * The feed is published to the private channel (GitHub Release asset, R2,
 * or even a USB stick in fase interna). The app verifies the signature with
 * the embedded public key and the artifact sha256 after download.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { FeedManifestSchema, signManifest } from "../src/domains/update/updater.ts";

function arg(name: string): string {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || !process.argv[idx + 1]) {
    console.error(`falta --${name}`);
    process.exit(1);
  }
  return process.argv[idx + 1]!;
}

const artifactPath = resolve(arg("artifact"));
const version = arg("version");
const channel = arg("channel");
const keyPath = resolve(arg("key"));
const outPath = resolve(arg("out"));

const bytes = readFileSync(artifactPath);
const manifest = FeedManifestSchema.parse({
  channel,
  version,
  createdAt: new Date().toISOString(),
  files: [
    {
      name: artifactPath.split("/").pop()!,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: statSync(artifactPath).size,
    },
  ],
});

const signature = signManifest(manifest, readFileSync(keyPath, "utf8"));
writeFileSync(outPath, JSON.stringify({ manifest, signature }, null, 2));
console.log(`feed firmado -> ${outPath}`);
console.log(`  versión ${version} · canal ${channel} · ${manifest.files[0]!.sha256.slice(0, 16)}…`);
