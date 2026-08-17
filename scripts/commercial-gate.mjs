#!/usr/bin/env node
/**
 * commercial-gate.mjs — checklist BLOQUEANTE de la fase comercial.
 *
 * Ninguna instalación fuera de PGK hasta que TODO esté en verde.
 * Cada check reporta PASS/FAIL y el exit code es no-cero si algo falta.
 *
 *   node scripts/commercial-gate.mjs
 *   npm run gate:commercial
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const results = [];
const check = (name, ok, hint = "") => results.push({ name, ok, hint });

function hasIdentity() {
  try {
    const out = execSync(
      "security find-identity -v -p codesigning 2>/dev/null || true",
      { encoding: "utf8" },
    );
    return /Developer ID Application/.test(out);
  } catch {
    return false;
  }
}

// 1) Firma Apple
check(
  "Developer ID Application en el llavero",
  hasIdentity(),
  "Apple Developer Program (99€/año) + 'Developer ID Application' cert instalado",
);

// 2) Notarización (cualquiera de las dos vías)
const notaryOk =
  Boolean(process.env.NOTARY_KEYCHAIN_PROFILE) ||
  (process.env.NOTARY_APPLE_ID && process.env.NOTARY_TEAM_ID);
check(
  "Credenciales de notarización",
  notaryOk,
  "NOTARY_KEYCHAIN_PROFILE (xcrun notarytool store-credentials) o NOTARY_APPLE_ID + NOTARY_TEAM_ID",
);

// 3) Firma Windows (Azure Trusted Signing)
const winOk = Boolean(
  process.env.AZURE_TRUSTED_SIGNING_CLIENT_ID &&
    process.env.AZURE_TRUSTED_SIGNING_TENANT_ID,
);
check(
  "Azure Trusted Signing configurado",
  winOk,
  "AZURE_TRUSTED_SIGNING_CLIENT_ID + AZURE_TRUSTED_SIGNING_TENANT_ID (+ secret en keychain)",
);

// 4) CI matrix mac + win
let ciOk = false;
const ciPath = resolve(root, ".github/workflows/ci.yml");
if (existsSync(ciPath)) {
  const ci = readFileSync(ciPath, "utf8");
  ciOk = /macos-latest/.test(ci) && /windows-latest/.test(ci);
}
check("CI matrix mac+win", ciOk, ".github/workflows/ci.yml con runs-on macos-latest y windows-latest");

// 5) electron-builder con DMG + NSIS firmables
let builderOk = false;
const builderPath = resolve(root, "electron-builder.yml");
if (existsSync(builderPath)) {
  const y = readFileSync(builderPath, "utf8");
  builderOk = /dmg/.test(y) && /nsis/.test(y) && /arm64/.test(y);
}
check("electron-builder (dmg arm64 + nsis x64)", builderOk, "electron-builder.yml con targets mac dmg y win nsis");

// 6) Clave pública de updates embebida
check(
  "Clave pública de updates (keys/update-public.pem)",
  existsSync(resolve(root, "keys/update-public.pem")),
  "node scripts/gen-keys.mjs ./keys (la privada JAMÁS se commitea)",
);

// 7) Entitlements: el dominio compila y sus tests existen
check(
  "Dominio entitlement (rechazo cross-tenant) presente",
  existsSync(resolve(root, "src/domains/entitlement/entitlement.ts")) &&
    existsSync(resolve(root, "tests/entitlement.test.ts")),
  "tests/entitlement.test.ts debe pasar (npm test)",
);

// 8) La superficie IPC sigue auditada
try {
  execSync("node scripts/audit-ipc.mjs", { cwd: root, stdio: "pipe" });
  check("Superficie IPC auditada", true);
} catch {
  check("Superficie IPC auditada", false, "node scripts/audit-ipc.mjs falla");
}

// ---------------------------------------------------------------- resumen
let width = Math.max(...results.map((r) => r.name.length));
let failures = 0;
console.log("═".repeat(width + 14));
console.log(" GATE COMERCIAL — SEASI Despacho");
console.log("═".repeat(width + 14));
for (const r of results) {
  const mark = r.ok ? "✓ PASS" : "✗ FAIL";
  if (!r.ok) failures += 1;
  console.log(` ${mark}  ${r.name}`);
  if (!r.ok && r.hint) console.log(`         ↳ ${r.hint}`);
}
console.log("═".repeat(width + 14));
if (failures > 0) {
  console.log(`\n ✗ ${failures} requisito(s) sin cruzar. NINGÚN inquilino externo hasta que todo esté en verde.\n`);
  process.exit(1);
}
console.log("\n ✓ Gate comercial en verde: autorizado el despliegue de inquilinos externos.\n");
