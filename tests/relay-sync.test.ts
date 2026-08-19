/**
 * Sincronización multi-máquina END TO END: dos OficinaStore (dos "máquinas"
 * con origen distinto) + dos clientes contra el relay REAL. Lo que se
 * appendea en A llega y persiste en B (idempotente ante replay/eco).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { OficinaRelayClient, type RelaySocketLike } from "../src/domains/oficina/relay-client";
import { OficinaStore } from "../src/domains/oficina/store";

const TOKEN = "sekreto-sync-test";

let accumulated = "";
const startWithCapture = () => {
  accumulated = "";
  const proc = spawn(process.execPath, ["relay/server.mjs"], {
    env: { ...process.env, RELAY_TOKEN: TOKEN, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (c: Buffer) => (accumulated += c.toString("utf8")));
  return { proc, getPort: async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const m = accumulated.match(/LISTENING (\d+)/);
      if (m) return Number(m[1]);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("relay no arrancó");
  } };
};

/** Adaptador ws → RelaySocketLike (mensaje como string). */
const wsFactory = (url: string): RelaySocketLike => {
  const ws = new WebSocket(url);
  const wrap = {
    send: (d: string) => ws.send(d),
    close: (code?: number, reason?: string) => ws.close(code, reason),
    on: (event: string, cb: (arg?: unknown) => void) => {
      if (event === "message") {
        ws.on("message", (data: unknown) => cb(String(data)));
      } else {
        ws.on(event, cb);
      }
    },
  };
  return wrap as RelaySocketLike;
};

const waitOpen = (client: OficinaRelayClient, ms = 6000): Promise<void> =>
  new Promise((resolve, reject) => {
    if (client.status() === "online") return resolve();
    const t = setTimeout(() => reject(new Error("timeout relay online")), ms);
    const poll = setInterval(() => {
      if (client.status() === "online") {
        clearInterval(poll);
        clearTimeout(t);
        resolve();
      }
    }, 50);
    setTimeout(() => clearInterval(poll), ms);
  });

const T = (h: number, m = 0): string => new Date(2026, 7, 19, h, m, 0).toISOString();

describe("sincronización A ↔ relay ↔ B", () => {
  const dirA = mkdtempSync(join(tmpdir(), "oficina-A-"));
  const dirB = mkdtempSync(join(tmpdir(), "oficina-B-"));
  let proc: ChildProcess;
  let port = 0;
  let storeA: OficinaStore;
  let storeB: OficinaStore;
  let clientA: OficinaRelayClient;
  let clientB: OficinaRelayClient;
  let appliedInB = 0;

  beforeAll(async () => {
    const s = startWithCapture();
    proc = s.proc;
    port = await s.getPort();
    storeA = new OficinaStore(join(dirA, "oficina.jsonl"));
    storeB = new OficinaStore(join(dirB, "oficina.jsonl"));
    clientA = new OficinaRelayClient(storeA, { url: `ws://127.0.0.1:${port}`, tenant: "pgk", token: TOKEN, persona: "kenyi" }, wsFactory);
    clientB = new OficinaRelayClient(storeB, { url: `ws://127.0.0.1:${port}`, tenant: "pgk", token: TOKEN, persona: "natalia" }, wsFactory, {
      onRemoteApplied: () => (appliedInB += 1),
    });
    clientA.start();
    clientB.start();
    await Promise.all([waitOpen(clientA), waitOpen(clientB)]);
  });

  afterAll(() => {
    clientA.stop();
    clientB.stop();
    proc.kill("SIGKILL");
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("roster: cada cliente ve a ambos", () => {
    expect(clientA.roster().map((p) => p.persona).sort()).toEqual(["kenyi", "natalia"]);
    expect(clientB.roster().map((p) => p.persona).sort()).toEqual(["kenyi", "natalia"]);
  });

  it("fichaje+nota+tarea de A aparecen en B (y persisten tras reabrir B)", async () => {
    const e1 = storeA.append("clock.in", "kenyi", { persona: "kenyi" }, T(9));
    const e2 = storeA.append("note", "kenyi", { persona: "kenyi", text: "buenos días, hoy 210s" }, T(9, 1));
    const e3 = storeA.append("task.created", "kenyi", { id: "m-210-leefflang", title: "Revisar 210 LEEFFLANG" }, T(9, 2));
    clientA.publish(e1);
    clientA.publish(e2);
    clientA.publish(e3);

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && appliedInB < 3) await new Promise((r) => setTimeout(r, 50));
    expect(appliedInB).toBe(3);

    const st = storeB.state(T(10), "natalia");
    expect(st.diary.map((d) => d.actor)).toContain("kenyi");
    expect(st.openClocks).toEqual(expect.arrayContaining([{ persona: "kenyi", since: T(9) }]));
    expect(st.tasks.map((t) => t.id)).toContain("m-210-leefflang");

    // persistencia: instancia nueva de B lee lo sincronizado
    const reopened = new OficinaStore(join(dirB, "oficina.jsonl"));
    expect(reopened.state(T(10), "natalia").tasks.map((t) => t.id)).toContain("m-210-leefflang");
  });

  it("replay del relay NO duplica en B (uid idempotente)", async () => {
    const before = storeB.read().length;
    // B se reconecta → hello-ok replay con los 3 eventos de A
    clientB.setPersona("natalia"); // fuerza stop+start
    await waitOpen(clientB);
    await new Promise((r) => setTimeout(r, 400)); // margen para replay
    const reopened = new OficinaStore(join(dirB, "oficina.jsonl"));
    expect(reopened.read().length).toBe(before); // cero duplicados
  });

  it("reglas locales de B siguen intactas tras sincronizar", () => {
    // kenyi está fichado (remoto) pero NATALIA puede fichar en B
    expect(() => storeB.append("clock.in", "natalia", { persona: "natalia" }, T(10, 5))).not.toThrow();
    // y mover la tarea creada por A
    expect(() => storeB.append("task.moved", "natalia", { id: "m-210-leefflang", to: "doing" }, T(10, 6))).not.toThrow();
    const e = storeB.append("clock.out", "natalia", { persona: "natalia" }, T(11));
    clientB.publish(e);
  });

  it("A recibe la salida de B (bidireccional)", async () => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const st = storeA.state(T(11, 1), "kenyi");
      if (!st.openClocks.some((c) => c.persona === "natalia")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const st = storeA.state(T(11, 1), "kenyi");
    expect(st.openClocks.some((c) => c.persona === "natalia")).toBe(false);
  });
});
