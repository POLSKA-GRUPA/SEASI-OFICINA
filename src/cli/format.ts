/**
 * Formateo puro de salida de la CLI — sin I/O, testeable en vitest.
 */
import type { HitlPauseLike, LedgerEventLike, UsageRow } from "../domains/kernel-bridge/client";

export function formatEventLine(e: LedgerEventLike): string {
  const at = typeof e.occurred_at === "string" ? e.occurred_at : "?";
  const payload = JSON.stringify(e.payload ?? {});
  const brief = payload.length > 120 ? `${payload.slice(0, 117)}…` : payload;
  return `#${e.seq}  ${at}  ${e.event_type}  ${brief}`;
}

export function formatHitlLine(p: HitlPauseLike): string {
  return `${String(p.pause_id)}  ${p.capability_id}  sesión=${String(p.session_id).slice(0, 8)}  expira=${p.expires_at}  sha256=${p.payload_digest}`;
}

export function formatStatus(s: {
  kernelVersion: string;
  adapters: string[];
  pendingHitl: number;
  usage: UsageRow[];
}): string {
  const tokens = s.usage.reduce((acc, r) => acc + r.input_tokens + r.output_tokens, 0);
  const turns = s.usage.reduce((acc, r) => acc + r.turns, 0);
  return [
    `kernel     ${s.kernelVersion}`,
    `adapters   ${s.adapters.join(", ") || "—"}`,
    `hitl       ${s.pendingHitl} pausa(s) pendiente(s)`,
    `uso        ${s.usage.length} sesión(es) · ${turns} turno(s) · ${tokens.toLocaleString()} tokens`,
  ].join("\n");
}

export function parseTailArgs(argv: string[]): { limit: number; follow: boolean } {
  let limit = 20;
  let follow = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--follow" || a === "-f") follow = true;
    else if (a === "-n" || a === "--limit") {
      const v = Number(argv[i + 1]);
      if (Number.isFinite(v) && v > 0) limit = Math.floor(v);
      i++;
    }
  }
  return { limit, follow };
}
