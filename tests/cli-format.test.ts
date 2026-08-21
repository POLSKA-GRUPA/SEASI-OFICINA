import { describe, expect, it } from "vitest";
import { formatEventLine, formatHitlLine, formatStatus, parseTailArgs } from "../src/cli/format";
import type { HitlPauseLike, LedgerEventLike } from "../src/domains/kernel-bridge/client";

const ev = (seq: number, payload: Record<string, unknown> = {}): LedgerEventLike => ({
  seq,
  event_id: `ev-${seq}`,
  event_type: "session.created",
  occurred_at: "2026-08-20T01:00:00Z",
  payload,
  hash: "abc",
});

describe("formatEventLine", () => {
  it("incluye seq, fecha, tipo y payload", () => {
    const line = formatEventLine(ev(7, { client_ref: "B111" }));
    expect(line).toContain("#7");
    expect(line).toContain("2026-08-20T01:00:00Z");
    expect(line).toContain("session.created");
    expect(line).toContain("B111");
  });

  it("trunca payloads largos a 120 chars", () => {
    const line = formatEventLine(ev(1, { blob: "x".repeat(500) }));
    expect(line.length).toBeLessThan(200);
    expect(line).toContain("…");
  });
});

describe("formatHitlLine", () => {
  it("incluye pause_id, capability y digest", () => {
    const pause = {
      pause_id: "p-1",
      session_id: "s-12345678abc",
      capability_id: "presentar_303",
      payload_digest: "deadbeef",
      expires_at: "2026-08-21T00:00:00Z",
    } as unknown as HitlPauseLike;
    const line = formatHitlLine(pause);
    expect(line).toContain("p-1");
    expect(line).toContain("presentar_303");
    expect(line).toContain("s-12345");
    expect(line).toContain("deadbeef");
  });
});

describe("formatStatus", () => {
  it("agrega sesiones, turnos y tokens", () => {
    const out = formatStatus({
      kernelVersion: "0.9.0",
      adapters: ["pi"],
      pendingHitl: 2,
      usage: [
        { session_id: "a", client_ref: "A", period_ref: "2026T3", model: null, turns: 3, input_tokens: 100, output_tokens: 50 },
        { session_id: "b", client_ref: "B", period_ref: "2026T3", model: null, turns: 1, input_tokens: 10, output_tokens: 5 },
      ],
    });
    expect(out).toContain("0.9.0");
    expect(out).toContain("pi");
    expect(out).toContain("2 pausa(s)");
    expect(out).toContain("2 sesión(es) · 4 turno(s) · 165 tokens");
  });
});

describe("parseTailArgs", () => {
  it("valores por defecto", () => {
    expect(parseTailArgs([])).toEqual({ limit: 20, follow: false });
  });
  it("-n y --follow", () => {
    expect(parseTailArgs(["-n", "5", "--follow"])).toEqual({ limit: 5, follow: true });
    expect(parseTailArgs(["-f"])).toEqual({ limit: 20, follow: true });
  });
  it("ignora límites inválidos", () => {
    expect(parseTailArgs(["-n", "-3"])).toEqual({ limit: 20, follow: false });
    expect(parseTailArgs(["--limit", "abc"])).toEqual({ limit: 20, follow: false });
  });
});
