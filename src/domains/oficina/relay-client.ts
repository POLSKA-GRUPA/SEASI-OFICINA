/**
 * Cliente del relay de La Oficina (main process).
 *
 * Publica los eventos LOCALES del store hacia el relay y aplica los
 * remotos con dedupe por uid (idempotente). Sin relay configurado, el
 * despacho funciona 100% local — este cliente simplemente no arranca.
 *
 * El socket es inyectable (interfaz mínima) para poder probar contra el
 * relay real sin acoplar el dominio a `ws`.
 */
import type { OficinaStore, StoredEvent, OficinaEventType } from "./store";

export type RelayStatus = "off" | "connecting" | "online";

export interface RelaySocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open" | "close" | "error", cb: (arg?: unknown) => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
}

export type WsFactory = (url: string) => RelaySocketLike;

export interface RelayClientOptions {
  url: string;
  tenant: string;
  token: string;
  persona: string;
}

export type Envelope = {
  type: OficinaEventType;
  actor: string;
  payload: unknown;
  uid: string;
  origin: string;
  ts?: string;
};

const HEARTBEAT_MS = 20_000;
const BACKOFF_MAX_MS = 30_000;

export class OficinaRelayClient {
  private ws: RelaySocketLike | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private statusValue: RelayStatus = "off";
  private rosterValue: { persona: string; since: string }[] = [];

  constructor(
    private readonly store: OficinaStore,
    private readonly opts: RelayClientOptions,
    private readonly wsFactory: WsFactory,
    private readonly hooks: {
      onRemoteApplied?: (event: StoredEvent) => void;
      onRoster?: (online: { persona: string; since: string }[]) => void;
      onStatus?: (status: RelayStatus) => void;
    } = {},
  ) {}

  status(): RelayStatus {
    return this.statusValue;
  }

  roster(): { persona: string; since: string }[] {
    return this.rosterValue;
  }

  url(): string {
    return this.opts.url;
  }

  start(): void {
    this.stopped = false;
    if (this.ws) return;
    this.setStatus("connecting");
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close(1000, "stop");
      } catch {
        /* ya cerrado */
      }
    }
    this.setStatus("off");
  }

  /** Cambiar la persona de presencia (re-hello). */
  setPersona(persona: string): void {
    this.opts.persona = persona;
    if (this.ws) {
      this.stop();
      this.start();
    }
  }

  /** Publicar un evento LOCAL recién appendeado (con uid+origin v2). */
  publish(ev: StoredEvent): void {
    if (this.statusValue !== "online" || !this.ws) return;
    if (!ev.uid || !ev.origin) return; // eventos v1 no viajan
    const envelope: Envelope = {
      type: ev.type,
      actor: ev.actor,
      payload: ev.payload,
      uid: ev.uid,
      origin: ev.origin,
      ts: ev.ts,
    };
    this.ws.send(JSON.stringify({ v: 1, kind: "event", envelope }));
  }

  // ── internals ──

  private connect(): void {
    const ws = this.wsFactory(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          v: 1,
          kind: "hello",
          tenant: this.opts.tenant,
          persona: this.opts.persona,
          token: this.opts.token,
        }),
      );
    });

    ws.on("message", (data: unknown) => {
      this.handleMessage(typeof data === "string" ? data : String(data));
    });

    ws.on("close", () => {
      this.clearTimers();
      this.ws = null;
      this.setStatus("off");
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on("error", () => {
      // 'close' llega detrás; nada que hacer aquí
    });
  }

  private handleMessage(raw: string): void {
    let msg: { v?: number; kind?: string; envelope?: Envelope; online?: { persona: string; since: string }[]; replay?: Envelope[] };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.v !== 1) return;

    if (msg.kind === "hello-ok") {
      this.attempts = 0;
      this.setStatus("online");
      this.startHeartbeat();
      for (const env of msg.replay ?? []) {
        this.applyEnvelope(env);
      }
      return;
    }
    if (msg.kind === "event" && msg.envelope) {
      this.applyEnvelope(msg.envelope);
      return;
    }
    if (msg.kind === "roster" && Array.isArray(msg.online)) {
      this.rosterValue = msg.online;
      this.hooks.onRoster?.(msg.online);
      return;
    }
    // pong y desconocidos → ignorar
  }

  private applyEnvelope(env: Envelope): void {
    if (!env || env.origin === this.store.origin()) return; // eco propio
    const res = this.store.applyRemote(env);
    if (res.applied) this.hooks.onRemoteApplied?.(res.event);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer ??= setInterval(() => {
      if (this.ws && this.statusValue === "online") {
        this.ws.send(JSON.stringify({ v: 1, kind: "ping" }));
      }
    }, HEARTBEAT_MS);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.attempts, BACKOFF_MAX_MS);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.setStatus("connecting");
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private setStatus(s: RelayStatus): void {
    if (this.statusValue === s) return;
    this.statusValue = s;
    this.hooks.onStatus?.(s);
  }
}
