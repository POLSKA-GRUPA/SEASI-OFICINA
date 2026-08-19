/**
 * Relay de La Oficina — tests de integración contra el servidor REAL
 * (child process con puerto efímero). Cubre: auth fail-closed, salas por
 * tenant, fan-out, replay para recién llegados, roster, ping/pong y healthz.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKEN = "sekreto-relay-test";

async function startServer(extraEnv: Record<string, string> = {}): Promise<{ proc: ChildProcess; port: number }> {
  const proc = spawn(process.execPath, ["relay/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, RELAY_TOKEN: TOKEN, PORT: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let port = 0;
  const deadline = Date.now() + 8000;
  outer: while (Date.now() < deadline) {
    const chunks: Buffer[] = [];
    // drenar stdout acumulado buscando LISTENING
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    await new Promise((r) => setTimeout(r, 100));
    const text = Buffer.concat(chunks).toString("utf8");
    const m = text.match(/LISTENING (\d+)/);
    if (m) {
      port = Number(m[1]);
      break outer;
    }
  }
  if (!port) throw new Error("relay no reportó LISTENING");
  return { proc, port };
}

type Msg = { v?: number; kind?: string; [k: string]: unknown };

/** Cliente WS con cola de mensajes y helpers de espera. */
class TestClient {
  ws: WebSocket;
  queue: Msg[] = [];
  waiters: { predicate: (m: Msg) => boolean; resolve: (m: Msg) => void }[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Msg;
      const i = this.waiters.findIndex((w) => w.predicate(msg));
      if (i >= 0) {
        const w = this.waiters.splice(i, 1)[0];
        if (w) w.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  send(m: Msg): void {
    this.ws.send(JSON.stringify(m));
  }

  async expect(predicate: (m: Msg) => boolean, ms = 4000): Promise<Msg> {
    const i = this.queue.findIndex(predicate);
    if (i >= 0) {
      const hit = this.queue.splice(i, 1)[0];
      if (hit) return hit;
    }
    return new Promise<Msg>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout esperando mensaje")), ms);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

async function connect(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await once(ws, "open");
  return new TestClient(ws);
}

const hello = (tenant: string, persona: string, token = TOKEN): Msg => ({ v: 1, kind: "hello", tenant, persona, token });
const ENV = { uid: "11111111-2222-3333-8444-555555555555", origin: "mc-test", type: "note", actor: "kenyi", payload: { persona: "kenyi", text: "hola desde A" } };

describe("relay de La Oficina", () => {
  let port = 0;
  let proc: ChildProcess;

  beforeAll(async () => {
    const s = await startServer();
    proc = s.proc;
    port = s.port;
  });
  afterAll(() => {
    proc.kill("SIGKILL");
  });

  it("healthz responde", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("auth fail-closed: token malo → close 4401", async () => {
    const c = await connect(port);
    const closed = once(c.ws, "close") as Promise<unknown[]>;
    c.send(hello("pgk", "intruso", "token-malo"));
    const [code] = await closed;
    expect(code).toBe(4401);
  });

  it("hello-timeout: sin hello → close 4401", async () => {
    const s2 = await startServer({ RELAY_HELLO_TIMEOUT_MS: "300" });
    const c = await connect(s2.port);
    const closed = once(c.ws, "close") as Promise<unknown[]>;
    const [code] = await closed;
    expect(code).toBe(4401);
    s2.proc.kill("SIGKILL");
  });

  it("dos compañeros: roster con ambos; fan-out A→B; eco a A; replay para C", async () => {
    const a = await connect(port);
    a.send(hello("pgk", "kenyi"));
    await a.expect((m) => m.kind === "hello-ok");

    const b = await connect(port);
    b.send(hello("pgk", "natalia"));
    await b.expect((m) => m.kind === "hello-ok");
    await b.expect((m) => m.kind === "roster" && Array.isArray(m.online) && (m.online as { persona: string }[]).some((p) => p.persona === "natalia"));

    // fan-out: A publica un evento → B lo recibe; A recibe su eco (y deduplica por uid el cliente)
    a.send({ v: 1, kind: "event", envelope: ENV });
    const gotB = await b.expect((m) => m.kind === "event");
    expect(gotB.envelope).toEqual(ENV);
    const echoA = await a.expect((m) => m.kind === "event");
    expect(echoA.envelope).toEqual(ENV);

    // C llega tarde → replay con el histórico
    const c = await connect(port);
    c.send(hello("pgk", "javi"));
    const okC = await c.expect((m) => m.kind === "hello-ok");
    expect(okC.replay).toEqual(expect.arrayContaining([ENV]));

    // aislamiento: los EVENTOS de otro tenant no cruzan (el roster del propio
    // tenant del outsider sí le llega — es legítimo y local a su sala)
    const outsider = await connect(port);
    outsider.send(hello("otro-tenant", "espia"));
    await outsider.expect((m) => m.kind === "hello-ok");
    a.send({ v: 1, kind: "event", envelope: { ...ENV, uid: "11111111-2222-3333-8444-555555555556", payload: { persona: "kenyi", text: "solo pgk" } } });
    const gotOnlyPgk = await b.expect((m) => m.kind === "event" && (m.envelope as { payload: { text: string } }).payload.text === "solo pgk");
    expect(gotOnlyPgk).toBeDefined();
    const leak = new Promise<string>((resolve) => {
      const onMsg = (data: WebSocket.RawData): void => {
        const m = JSON.parse(String(data)) as Msg;
        if (m.kind === "event") {
          outsider.ws.off("message", onMsg);
          resolve("fuga");
        }
      };
      outsider.ws.on("message", onMsg);
      setTimeout(() => {
        outsider.ws.off("message", onMsg);
        resolve("silencio");
      }, 600);
    });
    expect(await leak).toBe("silencio");

    // desconexión → roster se actualiza
    b.close();
    const left = await a.expect((m) => m.kind === "roster" && !(m.online as { persona: string }[]).some((p) => p.persona === "natalia"));
    expect(left).toBeDefined();

    // ping/pong
    a.send({ v: 1, kind: "ping" });
    await a.expect((m) => m.kind === "pong");
    a.close();
    c.close();
    outsider.close();
  });
});
