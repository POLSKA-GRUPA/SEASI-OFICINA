/**
 * CLI `seasi` — la oficina desde el terminal, contra el mismo kernel y el
 * mismo ledger que la app. Sin segunda autoridad: todo pasa por JSON-RPC.
 *
 *   seasi status
 *   seasi event tail [-n N] [--follow]
 *   seasi hitl list
 *   seasi hitl decide <pause_id> <approved|rejected> [--actor <quien>]
 *   seasi session send <session_id> <prompt…>
 *   seasi skill sign <dir> --key <private.pem> --name X --version V [--desc D]
 *   seasi skill verify <dir> --pubkey <public.pem>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KernelClient } from "../domains/kernel-bridge/client";
import {
  buildManifest,
  canonicalManifestJson,
  signManifest,
  verifySkillBundle,
} from "../domains/skills/bundle";
import { formatEventLine, formatHitlLine, formatStatus, parseTailArgs } from "./format";
import { KernelStdio } from "./kernel-stdio";

const TENANT = process.env.SEASI_TENANT ?? "pgk";

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
}

function usage(): never {
  console.error([
    "uso: seasi <comando>",
    "  status                                        estado del kernel, HITL y uso",
    "  event tail [-n N] [--follow]                  cola del ledger (–f sigue en vivo)",
    "  hitl list                                     pausas HITL pendientes",
    "  hitl decide <pause_id> <approved|rejected> [--actor X]",
    "  session send <session_id> <prompt…>           encargo por el canal de negocio",
    "  skill sign <dir> --key priv.pem --name X --version V [--desc D]",
    "  skill verify <dir> --pubkey pub.pem",
    "",
    `tenant: ${TENANT} (SEASI_TENANT) · kernel: SEASI_CORE_DIR · ledger: SEASI_DB`,
  ].join("\n"));
  process.exit(2);
}

async function withKernel<T>(fn: (k: KernelClient, io: KernelStdio) => Promise<T>): Promise<T> {
  const io = new KernelStdio();
  const client = new KernelClient((m, p) => io.call(m, p));
  try {
    return await fn(client, io);
  } finally {
    io.stop();
  }
}

async function cmdStatus(): Promise<void> {
  await withKernel(async (k) => {
    const [v, pending, usage] = await Promise.all([
      k.version(),
      k.listPendingHitl(TENANT),
      k.usageSummary(TENANT),
    ]);
    console.log(formatStatus({
      kernelVersion: v.kernel_version,
      adapters: v.adapters,
      pendingHitl: pending.length,
      usage,
    }));
  });
}

async function cmdEventTail(argv: string[]): Promise<void> {
  const { limit, follow } = parseTailArgs(argv);
  await withKernel(async (k) => {
    let events = await k.eventTail(TENANT, limit);
    for (const e of events) console.log(formatEventLine(e));
    if (!follow) return;
    let lastSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      events = await k.eventTail(TENANT, 100);
      const fresh = events
        .filter((e) => e.seq > lastSeq)
        .sort((a, b) => a.seq - b.seq);
      for (const e of fresh) {
        console.log(formatEventLine(e));
        lastSeq = e.seq;
      }
    }
  });
}

async function cmdHitl(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "list") {
    await withKernel(async (k) => {
      const pending = await k.listPendingHitl(TENANT);
      if (pending.length === 0) console.log("sin pausas pendientes");
      for (const p of pending) console.log(formatHitlLine(p));
    });
    return;
  }
  if (sub === "decide") {
    const pauseId = argv[1];
    const decision = argv[2];
    if (!pauseId || (decision !== "approved" && decision !== "rejected")) usage();
    const actor = flag(argv, "--actor") ?? process.env.USER ?? "cli";
    await withKernel(async (k) => {
      const res = await k.decideHitl({ pause_id: pauseId, decision, actor });
      console.log(`${decision === "approved" ? "✓ aprobado" : "✗ rechazado"} por ${actor}`);
      console.log(JSON.stringify(res.intent));
    });
    return;
  }
  usage();
}

async function cmdSession(argv: string[]): Promise<void> {
  if (argv[0] !== "send") usage();
  const sessionId = argv[1];
  const prompt = argv.slice(2).join(" ").trim();
  if (!sessionId || !prompt) usage();
  await withKernel(async (k, io) => {
    io.onNotification = (n) => {
      const params = n.params as { event?: { kind?: string } } | undefined;
      const kind = params?.event?.kind ?? "?";
      console.log(`· evento ${kind}`);
    };
    const res = await k.runSession({ tenant_id: TENANT, session_id: sessionId, prompt });
    console.log(`turno completado · ${res.events.length} evento(s) · sesión ${res.session_id.slice(0, 8)}`);
  });
}

function cmdSkill(argv: string[]): void {
  const sub = argv[0];
  const dir = argv[1];
  if (!dir) usage();
  if (sub === "sign") {
    const keyPath = flag(argv, "--key");
    const name = flag(argv, "--name");
    const version = flag(argv, "--version");
    if (!keyPath || !name || !version) usage();
    const manifest = buildManifest(dir, {
      name,
      version,
      tenant_id: TENANT,
      description: flag(argv, "--desc") ?? "",
    });
    const canonical = canonicalManifestJson(manifest);
    writeFileSync(join(dir, "manifest.json"), canonical);
    writeFileSync(join(dir, "manifest.sig"), signManifest(canonical, readFileSync(keyPath, "utf8")));
    console.log(`firmado: ${name}@${version} · ${manifest.files.length} archivo(s) · tenant ${TENANT}`);
    return;
  }
  if (sub === "verify") {
    const pubPath = flag(argv, "--pubkey");
    if (!pubPath) usage();
    const res = verifySkillBundle(dir, readFileSync(pubPath, "utf8"));
    if (res.ok) {
      console.log("✓ bundle íntegro y firma válida");
      return;
    }
    for (const e of res.errors) console.error(`✗ ${e}`);
    process.exit(1);
  }
  usage();
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "status") return cmdStatus();
  if (cmd === "event" && rest[0] === "tail") return cmdEventTail(rest.slice(1));
  if (cmd === "hitl") return cmdHitl(rest);
  if (cmd === "session") return cmdSession(rest);
  if (cmd === "skill") return cmdSkill(rest);
  usage();
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
