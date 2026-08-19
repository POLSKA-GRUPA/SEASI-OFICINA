/**
 * Oficina v0 — el event store humano del shell.
 * Cobertura: cadena hash (génesis, append, tamper), reglas de negocio
 * fail-closed (fichaje doble, out sin in, tareas), proyecciones (reloj,
 * board, diario del día) y persistencia entre instancias.
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  OficinaError,
  OficinaStore,
  eventHash,
  type StoredEvent,
} from "../src/domains/oficina/store";

const dir = mkdtempSync(join(tmpdir(), "oficina-test-"));
const file = join(dir, "oficina.jsonl");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T = (h: number, m = 0): string => new Date(2026, 7, 19, h, m, 0).toISOString(); // 19-08-2026 local

describe("cadena append-only", () => {
  it("génesis → append enlaza prev_hash y hash verifica", () => {
    const s = new OficinaStore(file);
    const e1 = s.append("clock.in", "kenyi", { persona: "kenyi" }, T(9, 2));
    expect(e1.seq).toBe(1);
    expect(e1.prev_hash).toBe("genesis");
    expect(e1.hash).toBe(eventHash(e1));
    const e2 = s.append("note", "kenyi", { persona: "kenyi", text: "buenos días" }, T(9, 3));
    expect(e2.prev_hash).toBe(e1.hash);
    expect(e2.seq).toBe(2);
  });

  it("verify() reporta ok y persiste entre instancias", () => {
    const s2 = new OficinaStore(file); // instancia NUEVA, mismo archivo
    const events = s2.read();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(s2.verify()).toMatchObject({ ok: true, events: events.length });
  });

  it("v2: eventos nuevos llevan uid+origin estables por máquina", () => {
    const s = new OficinaStore(file);
    const evs = s.read();
    for (const e of evs) {
      expect(e.uid).toMatch(/^[0-9a-f-]{36}$/);
      expect(e.origin).toMatch(/^mc-/);
    }
    expect(s.origin()).toBe(s.origin()); // estable
    const other = new OficinaStore(file);
    expect(other.origin()).toBe(s.origin()); // sidecar compartido
  });

  it("v1 legacy: log sin uid/origin carga y su cadena verifica", () => {
    const legacyFile = join(dir, "legacy.jsonl");
    // eventos v0.2 a mano (hash sin uid/origin)
    const mk = (seq: number, prev: string, type: string, actor: string, payload: unknown, ts: string) => {
      const base = { seq, ts, type, actor, payload, prev_hash: prev };
      const hash = createHash("sha256").update([seq, ts, type, actor, JSON.stringify(payload), prev].join("|"), "utf8").digest("hex");
      return `${JSON.stringify({ ...base, hash })}`;
    };
    const l1 = mk(1, "genesis", "note", "kenyi", { persona: "kenyi", text: "antes del relay" }, T(8));
    const h1 = JSON.parse(l1) as { hash: string };
    const l2 = mk(2, h1.hash, "clock.in", "kenyi", { persona: "kenyi" }, T(9));
    writeFileSync(legacyFile, `${l1}\n${l2}\n`, "utf8");
    const s = new OficinaStore(legacyFile);
    expect(s.read().length).toBe(2);
    expect(s.verify().ok).toBe(true);
    const ev = s.append("clock.out", "kenyi", { persona: "kenyi" }, T(18)); // mezcla v1+v2
    expect(ev.uid).toBeDefined();
  });

  it("tamper de una línea → chain_corrupt al reabrir", () => {
    const raw = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
    const victim = JSON.parse(raw[1] ?? "{}") as StoredEvent;
    victim.actor = "mallory";
    raw[1] = JSON.stringify(victim);
    const tampered = join(dir, "tampered.jsonl");
    writeFileSync(tampered, `${raw.join("\n")}\n`, "utf8");
    const s = new OficinaStore(tampered);
    expect(() => s.read()).toThrowError(OficinaError);
    expect(s.verify().ok).toBe(false);
  });
});

describe("reglas de negocio fail-closed", () => {
  const f2 = join(dir, "rules.jsonl");
  it("clock.in doble → clock_already_in y NO escribe", () => {
    const s = new OficinaStore(f2);
    s.append("clock.in", "kenyi", { persona: "kenyi" }, T(9));
    expect(() => s.append("clock.in", "kenyi", { persona: "kenyi" }, T(10))).toThrowError(/abierta/);
    expect(s.read().length).toBe(1);
  });

  it("clock.out sin jornada → clock_not_in", () => {
    const s = new OficinaStore(join(dir, "rules-out.jsonl"));
    expect(() => s.append("clock.out", "kenyi", { persona: "kenyi" }, T(18))).toThrowError(/abierta/);
  });

  it("task.created duplicado → task_duplicate; moved desconocido → task_unknown", () => {
    const s = new OficinaStore(join(dir, "rules-task.jsonl"));
    s.append("task.created", "kenyi", { id: "m-210-leefflang", title: "Revisar 210 LEEFFLANG" }, T(9));
    expect(() =>
      s.append("task.created", "kenyi", { id: "m-210-leefflang", title: "otra vez" }, T(10)),
    ).toThrowError(/ya existe/);
    expect(() => s.append("task.moved", "kenyi", { id: "fantasma", to: "done" }, T(11))).toThrowError(
      /desconocida/,
    );
  });

  it("payloads inválidos → invalid_payload (schema estricto)", () => {
    const s = new OficinaStore(join(dir, "rules-payload.jsonl"));
    expect(() => s.append("note", "kenyi", { persona: "kenyi" }, T(9))).toThrowError(OficinaError);
    expect(() => s.append("note", "", { persona: "x", text: "hola" }, T(9))).toThrowError(OficinaError);
    expect(() =>
      s.append("task.created", "kenyi", { id: "MAYUS", title: "x" }, T(9)),
    ).toThrowError(/kebab-case/);
  });

  it("cerrar y reabrir jornada funciona (in → out → in)", () => {
    const s = new OficinaStore(join(dir, "rules-reopen.jsonl"));
    s.append("clock.in", "kenyi", { persona: "kenyi" }, T(9));
    s.append("clock.out", "kenyi", { persona: "kenyi" }, T(14));
    expect(() => s.append("clock.in", "kenyi", { persona: "kenyi" }, T(16))).not.toThrow();
    const st = s.state(T(17), "kenyi");
    expect(st.clock.in).toBe(true);
    expect(st.clock.since).toBe(T(16));
  });

  it("fichaje POR-PERSONA: kenyi y natalia pueden estar fichadas a la vez", () => {
    const s = new OficinaStore(join(dir, "rules-multipersona.jsonl"));
    s.append("clock.in", "kenyi", { persona: "kenyi" }, T(9));
    expect(() => s.append("clock.in", "natalia", { persona: "natalia" }, T(9, 5))).not.toThrow();
    expect(() => s.append("clock.in", "kenyi", { persona: "kenyi" }, T(9, 30))).toThrowError(/kenyi ya tiene/);
    const st = s.state(T(10), "kenyi");
    expect(st.openClocks).toEqual(
      expect.arrayContaining([
        { persona: "kenyi", since: T(9) },
        { persona: "natalia", since: T(9, 5) },
      ]),
    );
    expect(st.clock.in).toBe(true); // la de kenyi
  });

  it("applyRemote: idempotente por uid + conflictos de tarea en silencio", () => {
    const s = new OficinaStore(join(dir, "remote.jsonl"));
    const env = {
      type: "note" as const,
      actor: "natalia",
      payload: { persona: "natalia", text: "buenos días desde mi máquina" },
      uid: "11111111-2222-3333-8444-555555555555",
      origin: "mc-otra",
    };
    const r1 = s.applyRemote(env);
    expect(r1.applied).toBe(true);
    const r2 = s.applyRemote({ ...env, ts: T(10) }); // replay del relay
    expect(r2).toMatchObject({ applied: false, reason: "duplicate" });
    // tarea remota con id que ya existe → skip, no error
    s.append("task.created", "kenyi", { id: "m-210", title: "La mía" }, T(9));
    const r3 = s.applyRemote({
      type: "task.created",
      actor: "natalia",
      payload: { id: "m-210", title: "La suya" },
      uid: "11111111-2222-3333-8444-555555555556",
      origin: "mc-otra",
    });
    expect(r3).toMatchObject({ applied: false, reason: "task_state" });
    // moved de tarea que solo existe allá → skip
    const r4 = s.applyRemote({
      type: "task.moved",
      actor: "natalia",
      payload: { id: "solo-alla", to: "done" },
      uid: "11111111-2222-3333-8444-555555555557",
      origin: "mc-otra",
    });
    expect(r4).toMatchObject({ applied: false, reason: "task_state" });
    // dedupe sobrevive a reabrir (rebuild desde el log)
    const s2 = new OficinaStore(join(dir, "remote.jsonl"));
    expect(s2.hasUid(env.uid)).toBe(true);
    expect(s2.applyRemote(env)).toMatchObject({ applied: false, reason: "duplicate" });
    // uid inválido → invalid
    expect(
      s.applyRemote({ type: "note", actor: "x", payload: { persona: "x", text: "hola" }, uid: "no-uuid", origin: "mc-x" }),
    ).toMatchObject({ applied: false, reason: "invalid" });
  });
});

describe("proyecciones", () => {
  const f3 = join(dir, "proj.jsonl");
  // jornada: 9:00→14:00 (5h) + 16:00→abierta; consultamos a las 18:00 → 7h
  const s = new OficinaStore(f3);
  s.append("clock.in", "kenyi", { persona: "kenyi" }, T(9));
  s.append("task.created", "kenyi", { id: "rename-shell", title: "Rename Despacho→Oficina", priority: "high" }, T(9, 30));
  s.append("clock.out", "kenyi", { persona: "kenyi", nota: "comida" }, T(14));
  s.append("clock.in", "kenyi", { persona: "kenyi" }, T(16));
  s.append("task.moved", "kenyi", { id: "rename-shell", to: "doing" }, T(16, 30));
  s.append("note", "kenyi", { persona: "kenyi", text: "CI verde en ambos SO" }, T(17));
  s.append("task.moved", "kenyi", { id: "rename-shell", to: "done" }, T(17, 30));

  it("reloj: total del día suma intervalos cerrados + abierto", () => {
    const st = s.state(T(18), "kenyi");
    expect(st.clock.in).toBe(true);
    expect(st.clock.todayMs).toBe(7 * 3600 * 1000);
    expect(st.clock.persona).toBe("kenyi");
  });

  it("board: tarea proyecta último estado", () => {
    const st = s.state(T(18), "kenyi");
    const t = st.tasks.find((x) => x.id === "rename-shell");
    expect(t).toBeDefined();
    expect(t?.status).toBe("done");
    expect(t?.priority).toBe("high");
    expect(t?.updated_at).toBe(T(17, 30));
  });

  it("diario: solo eventos de HOY, ordenados, con línea legible", () => {
    const st = s.state(T(18), "kenyi");
    expect(st.diary.length).toBe(7);
    expect(st.diary[0]?.type).toBe("clock.in");
    expect(st.diary[5]?.text).toBe("CI verde en ambos SO");
    expect(st.diary[6]?.text).toContain("→ done");
  });

  it("diario excluye otro día local", () => {
    const otroDia = new Date(2026, 7, 20, 10, 0).toISOString();
    const st = s.state(otroDia, "kenyi");
    expect(st.diary.length).toBe(0);
    expect(st.clock.in).toBe(false); // jornada abierta era de ayer
    expect(st.tasks.length).toBe(1); // el board es acumulativo
  });
});
