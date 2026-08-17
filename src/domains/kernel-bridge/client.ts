/**
 * Typed kernel client: validates every response with generated zod schemas
 * and maps kernel JSON-RPC error codes to typed domain errors.
 * Pure module — the transport is injected, so tests need no Electron.
 */
import type { ZodType } from "zod";
import { AgentSessionSchema, HitlPauseSchema } from "../../contracts/gen/schemas";

export type Invoke = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export class KernelError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`[${code}] ${message}`);
    this.name = "KernelError";
  }
  get isTenantScope(): boolean { return this.code === 101; }
  get isEffectUnapproved(): boolean { return this.code === 102; }
  get isUnknownAdapter(): boolean { return this.code === 103; }
  get isFailClosed(): boolean { return this.code === 100; }
  get isMethodNotFound(): boolean { return this.code === -32601; }
  get isInvalidParams(): boolean { return this.code === -32602; }
}

type RpcEnvelope = { error?: { code: number; message: string; data?: unknown } };

function toKernelError(payload: string): KernelError {
  try {
    const parsed = JSON.parse(payload) as Partial<RpcEnvelope> & { code?: number; message?: string; data?: unknown };
    // shape 1: {error: {code, message}} · shape 2: {code, message} (as rejected by main)
    const err = parsed.error ?? (typeof parsed.code === "number" ? parsed : undefined);
    if (err && typeof err.code === "number") {
      return new KernelError(err.code, String(err.message ?? "kernel error"), err.data);
    }
  } catch {
    /* fallthrough */
  }
  return new KernelError(-32603, payload.slice(0, 300));
}

export class KernelClient {
  constructor(private readonly invoke: Invoke) {}

  async version(): Promise<{ kernel_version: string; adapters: string[] }> {
    let raw: unknown;
    try {
      raw = await this.invoke("seasi.version");
    } catch (err) {
      throw toKernelError(err instanceof Error ? err.message : String(err));
    }
    const v = raw as { kernel_version?: unknown; adapters?: unknown };
    if (typeof v.kernel_version !== "string" || !Array.isArray(v.adapters)) {
      throw new KernelError(-32603, "seasi.version: malformed response");
    }
    return { kernel_version: v.kernel_version, adapters: v.adapters as string[] };
  }

  async startSession(p: {
    tenant_id: string;
    client_ref: string;
    period_ref: string;
    adapter?: string;
  }): Promise<AgentSessionLike> {
    return this.call("seasi.session.start", p, AgentSessionSchema);
  }

  async listPendingHitl(tenantId: string): Promise<HitlPauseLike[]> {
    const raw = await this.invoke("seasi.hitl.list", { tenant_id: tenantId });
    const obj = raw as { pending?: unknown };
    const pending = Array.isArray(obj.pending) ? obj.pending : [];
    return pending.map((entry) => this.parse(entry, HitlPauseSchema));
  }

  async createHitl(p: {
    tenant_id: string;
    session_id: string;
    capability_id: string;
    payload_digest: string;
  }): Promise<HitlPauseLike> {
    return this.call("seasi.hitl.create", p, HitlPauseSchema);
  }

  async decideHitl(p: {
    pause_id: string;
    decision: "approved" | "rejected";
    actor: string;
  }): Promise<{ intent: Record<string, unknown> }> {
    const raw = await this.call("seasi.hitl.decide", p, null);
    const obj = raw as { intent?: Record<string, unknown> };
    if (!obj.intent) throw new KernelError(-32603, "hitl.decide: missing intent");
    return { intent: obj.intent };
  }

  async eventTail(tenantId: string, limit = 50): Promise<LedgerEventLike[]> {
    const raw = await this.invoke("seasi.event.tail", {
      tenant_id: tenantId,
      limit,
    });
    const obj = raw as { events?: unknown };
    const events = Array.isArray(obj.events) ? obj.events : [];
    return events.map((e) => {
      const rec = e as Record<string, unknown>;
      for (const field of ["seq", "event_id", "event_type", "hash"]) {
        if (typeof rec[field] === "undefined") {
          throw new KernelError(-32603, `event.tail: missing ${field}`);
        }
      }
      return rec as unknown as LedgerEventLike;
    });
  }

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    schema: ZodType<T> | null,
  ): Promise<T> {
    let raw: unknown;
    try {
      raw = await this.invoke(method, params);
    } catch (err) {
      throw toKernelError(err instanceof Error ? err.message : String(err));
    }
    if (schema === null) return raw as T;
    return this.parse(raw, schema);
  }

  private parse<T>(raw: unknown, schema: ZodType<T>): T {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new KernelError(-32603, `${"schema validation failed"}`, result.error.issues);
    }
    return result.data;
  }
}

// Structural aliases (avoid exporting raw zod-inferred types at every call site)
export type AgentSessionLike = ReturnType<typeof AgentSessionSchema.parse>;
export type HitlPauseLike = ReturnType<typeof HitlPauseSchema.parse>;
export type LedgerEventLike = {
  seq: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  hash: string;
};
