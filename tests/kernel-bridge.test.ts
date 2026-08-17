/**
 * HARD suite: kernel-bridge typed client + REAL end-to-end parity against
 * the Python kernel spawned via `uv run python -m seasi_core.rpc`.
 * If the kernel contract drifts, this file catches it at shell-CI time.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelClient, KernelError } from "../src/domains/kernel-bridge/client";

const here = dirname(fileURLToPath(import.meta.url));
const CORE_DIR = resolve(here, "../../SEASI-CORE");

class StdioKernel {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private seq = 0;
  private waiters = new Map<number, (line: string) => void>();

  start(dbDir: string): void {
    this.proc = spawn(
      "uv",
      ["run", "--project", CORE_DIR, "python", "-m", "seasi_core.rpc"],
      {
        env: {
          ...process.env,
          SEASI_DB: join(dbDir, "led.db"),
          SEASI_ROOT: join(dbDir, "ws"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) {
          const parsed = JSON.parse(line) as { id?: number };
          const waiter = this.waiters.get(Number(parsed.id));
          if (waiter) {
            this.waiters.delete(Number(parsed.id));
            waiter(line);
          }
        }
        idx = this.buffer.indexOf("\n");
      }
    });
  }

  invoke(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolvePromise, rejectPromise) => {
      if (!this.proc?.stdin) {
        rejectPromise(new Error("kernel stdin cerrado"));
        return;
      }
      this.waiters.set(id, (line) => {
        try {
          const env = JSON.parse(line) as { result?: unknown; error?: unknown };
          if (env.error) rejectPromise(new Error(JSON.stringify(env.error)));
          else resolvePromise(env.result);
        } catch (err) {
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
        }
      });
      this.proc.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n",
      );
    });
  }

  stop(): void {
    this.proc?.stdin?.end();
    this.proc?.kill();
    this.proc = null;
  }
}

// ------------------------------------------------------- pure client unit

describe("KernelClient (unit, fake transport)", () => {
  it("mapea cada código de error del kernel a un flag tipado", async () => {
    const codes: [number, keyof KernelError][] = [
      [100, "isFailClosed"],
      [101, "isTenantScope"],
      [102, "isEffectUnapproved"],
      [103, "isUnknownAdapter"],
      [-32601, "isMethodNotFound"],
      [-32602, "isInvalidParams"],
    ];
    await Promise.all(
      codes.map(async ([code, flag]) => {
        const client = new KernelClient(() =>
          Promise.reject(new Error(JSON.stringify({ code, message: "x" }))),
        );
        const err = await client.version().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(KernelError);
        const ke = err as KernelError;
        expect(ke.code).toBe(code);
        expect(Boolean(ke[flag])).toBe(true);
      }),
    );
  });

  it("respuesta malformada → KernelError -32603 (no datos crudos)", async () => {
    const client = new KernelClient(() => Promise.resolve({ adapters: "no-array" }));
    await expect(client.version()).rejects.toMatchObject({ code: -32603 });
  });

  it("hitl.list con pending corrupto → error tipado", async () => {
    const client = new KernelClient(() => Promise.resolve({ pending: [{ fake: true }] }));
    await expect(client.listPendingHitl("pgk")).rejects.toBeInstanceOf(KernelError);
  });

  it("event.tail exige campos del ledger", async () => {
    const client = new KernelClient(() => Promise.resolve({ events: [{ seq: 1 }] }));
    await expect(client.eventTail("pgk")).rejects.toMatchObject({ code: -32603 });
  });
});

// --------------------------------------------------- real integration

describe("KernelClient ↔ kernel real (uv + stdio)", () => {
  const kernel = new StdioKernel();
  let client: KernelClient;
  const dbDir = mkdtempSync(join(tmpdir(), "seasi-parity-"));

  beforeAll(() => {
    kernel.start(dbDir);
    client = new KernelClient((m, p) => kernel.invoke(m, p));
  });

  afterAll(() => kernel.stop());

  it("seasi.version viaja y valida", async () => {
    const v = await client.version();
    expect(v.kernel_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.adapters).toContain("pi");
  });

  it("flujo completo: sesión → pausa HITL → list → decide → cola vacía", async () => {
    const session = await client.startSession({
      tenant_id: "pgk",
      client_ref: "B42970335",
      period_ref: "2026T3",
    });
    expect(session.state).toBe("created");
    expect(session.adapter).toBe("pi");

    const pause = await client.createHitl({
      tenant_id: "pgk",
      session_id: String(session.session_id),
      capability_id: "filing.submit",
      payload_digest: "e".repeat(64),
    });
    expect(pause.status).toBe("pending");
    expect(pause.capability_id).toBe("filing.submit");

    const pending = await client.listPendingHitl("pgk");
    expect(pending.map((p) => p.pause_id)).toContain(pause.pause_id);

    const { intent } = await client.decideHitl({
      pause_id: String(pause.pause_id),
      decision: "approved",
      actor: "test-paridad",
    });
    expect(intent.actor).toBe("test-paridad");
    expect(String((intent as Record<string, unknown>).payload_digest)).toBe("e".repeat(64));

    expect(await client.listPendingHitl("pgk")).toEqual([]);
  });

  it("doble decide falla cerrado con código kernel 100", async () => {
    const session = await client.startSession({
      tenant_id: "pgk",
      client_ref: "X",
      period_ref: "2026T1",
    });
    const pause = await client.createHitl({
      tenant_id: "pgk",
      session_id: String(session.session_id),
      capability_id: "email.send",
      payload_digest: "f".repeat(64),
    });
    await client.decideHitl({ pause_id: String(pause.pause_id), decision: "rejected", actor: "a" });
    await expect(
      client.decideHitl({ pause_id: String(pause.pause_id), decision: "approved", actor: "b" }),
    ).rejects.toMatchObject({ code: 100 });
  });

  it("tenant inválido → SEASI_TENANT_SCOPE (101)", async () => {
    await expect(
      client.startSession({ tenant_id: "PGK!", client_ref: "x", period_ref: "2026T3" }),
    ).rejects.toMatchObject({ code: 101 });
  });

  it("event.tail devuelve eventos con hash del ledger", async () => {
    const events = await client.eventTail("pgk", 10);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof e.event_type).toBe("string");
    }
    expect(events.some((e) => e.event_type === "session.created")).toBe(true);
  });

  it("digest de contratos idéntico al MANIFEST del kernel", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(join(CORE_DIR, "schemas/v1/MANIFEST.json"), "utf8"),
    ) as { files: Record<string, string> };
    const { CONTRACT_DIGESTS } = await import("../src/contracts/gen/schemas");
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(CONTRACT_DIGESTS[name as keyof typeof CONTRACT_DIGESTS]).toBe(digest);
    }
  });
});
