#!/usr/bin/env node
/**
 * audit-ipc.mjs — CI gate: the preload bridge surface must stay exactly the
 * audited allowlist. Any new IPC surface must be a conscious change here.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const preload = readFileSync(resolve(here, "../src/preload/index.ts"), "utf8");
const main = readFileSync(resolve(here, "../src/main/index.ts"), "utf8");

const EXPECTED_SHELL = [
  "vaultList",
  "vaultSet",
  "vaultDelete",
  "brainList",
  "brainRead",
  "brainWrite",
  "backupCreate",
  "backupList",
  "backupVerify",
  "updateCheck",
  "branding",
  "mcpStatus",
  "onSessionEvent",
  "diagnosticsExport",
  "oficinaState",
  "oficinaAppend",
  "oficinaVerify",
  "onOficinaEvent",
  "oficinaIdentify",
  "relayStatus",
];

const EXPECTED_EVENT_CHANNELS = ["shell:session:event", "shell:oficina:event"];

const EXPECTED_CHANNELS = [
  "seasi:rpc",
  "shell:vault:list",
  "shell:vault:set",
  "shell:vault:delete",
  "shell:brain:list",
  "shell:brain:read",
  "shell:brain:write",
  "shell:backup:create",
  "shell:backup:list",
  "shell:backup:verify",
  "shell:update:check",
  "shell:branding:get",
  "shell:mcp:status",
  "shell:diagnostics:export",
  "shell:oficina:state",
  "shell:oficina:append",
  "shell:oficina:verify",
  "shell:oficina:identify",
  "shell:oficina:relay",
];

const problems = [];

for (const fn of EXPECTED_SHELL) {
  if (!new RegExp(`\\b${fn}:\\s*\\(`).test(preload)) {
    problems.push(`preload perdió el método ${fn}`);
  }
}
for (const ch of EXPECTED_CHANNELS) {
  if (!main.includes(`"${ch}"`)) {
    problems.push(`main perdió el canal ${ch}`);
  }
}

// main must register NO ipc channel outside the allowlist
const registered = [...main.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map((m) => m[1]);
const unexpected = registered.filter((ch) => !EXPECTED_CHANNELS.includes(ch));
if (unexpected.length > 0) problems.push(`canales no auditados en main: ${unexpected.join(", ")}`);
if (!preload.includes("exposeInMainWorld(\"seasi\"")) {
  problems.push("preload debe exponer exactamente el objeto 'seasi'");
}

// preload may only SUBSCRIBE to the audited event channels
const subscribed = [...preload.matchAll(/ipcRenderer\.on\(\s*"([^"]+)"/g)].map((m) => m[1]);
const badEvents = subscribed.filter((ch) => !EXPECTED_EVENT_CHANNELS.includes(ch));
if (badEvents.length > 0) problems.push(`eventos IPC no auditados en preload: ${badEvents.join(", ")}`);
for (const ch of EXPECTED_EVENT_CHANNELS) {
  if (!preload.includes(`"${ch}"`)) problems.push(`preload perdió el evento ${ch}`);
}

if (problems.length > 0) {
  console.error("AUDIT-IPC FALLÓ:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OK: superficie IPC auditada (${EXPECTED_CHANNELS.length} canales, ${EXPECTED_EVENT_CHANNELS.length} eventos, ${EXPECTED_SHELL.length} métodos shell)`);
