import { describe, expect, it } from "vitest";
import {
  classifyDiffLine,
  emptyFeed,
  looksLikeUnifiedDiff,
  reduceFeed,
  type FeedAction,
  type FeedMessage,
  type SessionFeedState,
  type SessionStreamEvent,
} from "../src/domains/feed/session-feed-assembler";

const ev = (kind: string, data: Record<string, unknown> = {}, occurredAt?: string): SessionStreamEvent => ({
  kind,
  adapter: "dragon",
  data,
  occurred_at: occurredAt,
});

const fold = (events: SessionStreamEvent[]): SessionFeedState =>
  events.reduce(reduceFeed, emptyFeed());

describe("reduceFeed", () => {
  it("spawned reinicia el feed y pone la fase en running", () => {
    const s = fold([ev("message", { raw: "viejo" }), ev("spawned", { argv: ["uv"] })]);
    expect(s.items).toEqual([]);
    expect(s.phase).toBe("running");
    expect(s.thinking).toBe(true);
  });

  it("fusiona messages consecutivos del mismo adapter", () => {
    const s = fold([ev("spawned"), ev("message", { raw: "línea 1" }), ev("message", { raw: "línea 2" })]);
    expect(s.items).toHaveLength(1);
    expect((s.items[0] as FeedMessage).lines).toEqual(["línea 1", "línea 2"]);
    expect(s.turns).toBe(2);
  });

  it("no fusiona messages de adapters distintos", () => {
    const s = fold([
      ev("spawned"),
      ev("message", { raw: "a" }),
      { kind: "message", adapter: "cecilia", data: { raw: "b" } },
    ]);
    expect(s.items).toHaveLength(2);
  });

  it("tool_call abre acción running y tool_result la cierra con duración", () => {
    const s = fold([
      ev("spawned"),
      ev("tool_call", { tool: "leer-facturas", period: "2026T3" }, "2026-08-20T10:00:00Z"),
      ev("tool_result", { count: 42 }, "2026-08-20T10:00:02.100Z"),
    ]);
    const action = s.items[0] as FeedAction;
    expect(action.name).toBe("leer-facturas");
    expect(action.status).toBe("ok");
    expect(action.durationMs).toBe(2100);
    expect(action.resultSummary).toContain("42");
  });

  it("tool_result con error marca la acción como fail", () => {
    const s = fold([ev("spawned"), ev("tool_call", { tool: "x" }), ev("tool_result", { error: "boom" })]);
    expect((s.items[0] as FeedAction).status).toBe("fail");
  });

  it("cierra las acciones en orden FIFO", () => {
    const s = fold([
      ev("spawned"),
      ev("tool_call", { tool: "primera" }),
      ev("tool_call", { tool: "segunda" }),
      ev("tool_result", {}),
    ]);
    expect((s.items[0] as FeedAction).status).toBe("ok");
    expect((s.items[1] as FeedAction).status).toBe("running");
  });

  it("tool_result sin acción abierta no rompe nada", () => {
    const s = fold([ev("spawned"), ev("tool_result", {})]);
    expect(s.items).toEqual([]);
  });

  it("usage acumula tokens sin crear items", () => {
    const s = fold([ev("spawned"), ev("usage", { input_tokens: 100, output_tokens: 40 }), ev("usage", { input_tokens: 10 })]);
    expect(s.inputTokens).toBe(110);
    expect(s.outputTokens).toBe(40);
    expect(s.items).toEqual([]);
  });

  it("hitl_required crea acard warn y pausa la fase", () => {
    const s = fold([ev("spawned"), ev("hitl_required", { capability_id: "filing.submit" })]);
    const action = s.items[0] as FeedAction;
    expect(action.status).toBe("warn");
    expect(action.name).toBe("filing.submit");
    expect(s.phase).toBe("paused_hitl");
    expect(s.thinking).toBe(false);
  });

  it("completed/failed/cancelled cierran la fase", () => {
    expect(fold([ev("spawned"), ev("completed", { returncode: 0 })]).phase).toBe("completed");
    expect(fold([ev("spawned"), ev("failed", { returncode: 1 })]).phase).toBe("failed");
    expect(fold([ev("spawned"), ev("cancelled")]).phase).toBe("cancelled");
  });

  it("kinds desconocidos no alteran el estado", () => {
    const base = fold([ev("spawned"), ev("message", { raw: "x" })]);
    expect(reduceFeed(base, ev("algo_nuevo"))).toBe(base);
  });
});

describe("diff helpers", () => {
  it("clasifica líneas de diff unificado", () => {
    expect(classifyDiffLine("+añadida")).toBe("add");
    expect(classifyDiffLine("-quitada")).toBe("del");
    expect(classifyDiffLine("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(classifyDiffLine("+++ b/f.ts")).toBe("context");
    expect(classifyDiffLine(" contexto")).toBe("context");
  });

  it("detecta bloques que parecen diff", () => {
    expect(looksLikeUnifiedDiff(["@@ -1 +1 @@", "-a", "+b"])).toBe(true);
    expect(looksLikeUnifiedDiff(["hola", "mundo"])).toBe(false);
    expect(looksLikeUnifiedDiff([])).toBe(false);
  });
});
