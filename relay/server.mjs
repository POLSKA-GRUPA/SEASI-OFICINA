#!/usr/bin/env node
/**
 * relay/server.mjs — relay de tiempo real de La Oficina.
 *
 * Estado MÍNIMO y sin verdad de negocio: fan-out de eventos entre las
 * máquinas de un mismo tenant + presencia (quién está conectado) + replay
 * de los últimos N eventos al conectar. La VERDAD persiste en el
 * oficina.jsonl de cada cliente (hash-chain); este servidor es solo el
 * cable. Si arde, nadie pierde datos — solo se pierde el "en vivo".
 *
 * Protocolo (JSON en frames de texto WS):
 *   C→S {v:1, kind:"hello", tenant, persona, token}   (PRIMERO, en <5s)
 *   S→C {v:1, kind:"hello-ok", replay: Ev[]}          (últimos 50 del tenant)
 *   C→S {v:1, kind:"event", envelope: Ev}             → fan-out al tenant
 *   S→C {v:1, kind:"event", envelope: Ev}
 *   S→C {v:1, kind:"roster", online:[{persona,since}]}
 *   C→S {v:1, kind:"ping"} → S→C {v:1, kind:"pong"}
 *
 * Auth: token compartido (env RELAY_TOKEN), comparación timing-safe.
 * Fail-closed: sin hello válido → close 4401; mensaje raro → ignorado.
 * Aislamiento: un socket solo habla con su tenant (elegido en hello).
 *
 * Deploy (VPS): RELAY_TOKEN=… PORT=8787 node relay/server.mjs
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.RELAY_TOKEN ?? "";
const TTL_MS = Number(process.env.RELAY_TTL_MS ?? 45_000);
const HELLO_TIMEOUT_MS = Number(process.env.RELAY_HELLO_TIMEOUT_MS ?? 5_000);
const REPLAY_SIZE = Number(process.env.RELAY_REPLAY_SIZE ?? 50);
const MAX_PAYLOAD = 64 * 1024;

if (!TOKEN) {
  console.error("relay: falta RELAY_TOKEN (fail-closed, no arranco sin secreto)");
  process.exit(1);
}

/** @typedef {{socket: import("ws").WebSocket, tenant: string, persona: string, since: number, lastBeat: number}} Client */

const http = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, clients: byTenantSize() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD });

/** @type {Map<import("ws").WebSocket, Client|null>} */
const clients = new Map();
/** @type {Map<string, Ev[]>} buffers de replay por tenant */
const replay = new Map();
/** @type {Map<string, number>} contador por tenant (para /healthz) */

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

const tenants = () => {
  const m = new Map();
  for (const c of clients.values()) if (c) m.set(c.tenant, (m.get(c.tenant) ?? 0) + 1);
  return m;
};
function byTenantSize() {
  return Object.fromEntries([...tenants().entries()]);
}

function tokenOk(candidate) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function rosterOf(tenant) {
  const online = [];
  for (const c of clients.values()) {
    if (c && c.tenant === tenant) online.push({ persona: c.persona, since: new Date(c.since).toISOString() });
  }
  online.sort((x, y) => x.persona.localeCompare(y.persona));
  return online;
}

function broadcastRoster(tenant) {
  const online = rosterOf(tenant);
  for (const c of clients.values()) {
    if (c && c.tenant === tenant) send(c.socket, { v: 1, kind: "roster", online });
  }
}

function fanoutEvent(tenant, envelope) {
  const buf = replay.get(tenant) ?? [];
  buf.push(envelope);
  while (buf.length > REPLAY_SIZE) buf.shift();
  replay.set(tenant, buf);
  for (const c of clients.values()) {
    if (c && c.tenant === tenant) send(c.socket, { v: 1, kind: "event", envelope });
  }
}

const validEnvelope = (e) =>
  Boolean(
    e &&
      typeof e === "object" &&
      typeof e.type === "string" &&
      e.type.length > 0 &&
      typeof e.actor === "string" &&
      typeof e.uid === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.uid) &&
      typeof e.origin === "string" &&
      e.origin.length > 0,
  );

wss.on("connection", (ws) => {
  /** @type {Client|null} */
  let me = null;
  const helloTimer = setTimeout(() => {
    if (!me) ws.close(4401, "hello-timeout");
  }, HELLO_TIMEOUT_MS);

  ws.on("pong", () => {
    if (me) me.lastBeat = Date.now();
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // ruido → ignorar
    }
    if (!msg || msg.v !== 1) return;

    if (!me) {
      if (msg.kind !== "hello") return;
      clearTimeout(helloTimer);
      if (typeof msg.tenant !== "string" || typeof msg.persona !== "string" || !tokenOk(msg.token)) {
        ws.close(4401, "auth");
        return;
      }
      me = { socket: ws, tenant: msg.tenant, persona: msg.persona, since: Date.now(), lastBeat: Date.now() };
      clients.set(ws, me);
      send(ws, { v: 1, kind: "hello-ok", replay: replay.get(me.tenant) ?? [] });
      broadcastRoster(me.tenant);
      return;
    }

    me.lastBeat = Date.now();
    if (msg.kind === "ping") {
      send(ws, { v: 1, kind: "pong" });
      return;
    }
    if (msg.kind === "event") {
      if (!validEnvelope(msg.envelope)) return;
      fanoutEvent(me.tenant, msg.envelope);
      return;
    }
    // kind desconocido → ignorar (fail-closed silencioso)
  });

  ws.on("close", () => {
    clearTimeout(helloTimer);
    const had = clients.get(ws);
    clients.delete(ws);
    if (had) broadcastRoster(had.tenant);
  });
});

// presencia: evict silenciosos + ping keepalive
setInterval(() => {
  const now = Date.now();
  for (const [ws, c] of clients.entries()) {
    if (!c) continue;
    if (now - c.lastBeat > TTL_MS) {
      ws.terminate();
      clients.delete(ws);
      broadcastRoster(c.tenant);
      continue;
    }
    ws.ping();
  }
}, Math.min(TTL_MS / 3, 15_000));

http.listen(PORT, () => {
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : PORT;
  console.log(`LISTENING ${port}`); // contrato con los tests y el deploy
});
