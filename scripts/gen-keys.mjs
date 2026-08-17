#!/usr/bin/env node
/**
 * gen-keys.mjs — generate the ed25519 update channel keypair (fase interna).
 *
 *   node scripts/gen-keys.mjs ./keys
 *
 * Produces update-private.pem (GUARDAR FUERA DEL REPO — firma releases) and
 * update-public.pem (se distribuye embebida en la app / userData).
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const outDir = resolve(process.argv[2] ?? "./keys");
mkdirSync(outDir, { recursive: true });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pub = publicKey.export({ type: "spki", format: "pem" }).toString();

writeFileSync(resolve(outDir, "update-private.pem"), priv);
chmodSync(resolve(outDir, "update-private.pem"), 0o600);
writeFileSync(resolve(outDir, "update-public.pem"), pub);
console.log(`par ed25519 generado en ${outDir}`);
console.log("- update-private.pem  → SOLO en la máquina que firma releases");
console.log("- update-public.pem   → embebida en la app (userData/update-public.pem)");
