/**
 * Transporte stdio para la CLI: lanza el kernel SEASI-CORE igual que el main
 * process de la app (uv run … seasi_core.rpc) y habla JSON-RPC por líneas.
 * Misma autoridad, mismo ledger: la CLI no es una segunda fuente de verdad.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type KernelNotification = { method: string; params: unknown };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Mismo userData que Electron (productName "La Oficina") por plataforma. */
export function defaultUserDataDir(): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "La Oficina");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "La Oficina");
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "La Oficina");
}

export class KernelStdio {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  onNotification: ((n: KernelNotification) => void) | null = null;

  start(): void {
    if (this.proc && this.proc.exitCode === null) return;
    const coreDir = process.env.SEASI_CORE_DIR ?? join(homedir(), "repos", "SEASI-CORE");
    const userData = defaultUserDataDir();
    const root = process.env.SEASI_ROOT ?? join(userData, "workspace");
    mkdirSync(root, { recursive: true });
    this.buffer = "";
    this.proc = spawn(
      "uv",
      ["run", "--project", coreDir, "python", "-m", "seasi_core.rpc"],
      {
        env: {
          ...process.env,
          SEASI_DB: process.env.SEASI_DB ?? join(userData, "ledger.db"),
          SEASI_ROOT: root,
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    this.proc.stdout?.setEncoding("utf8");
    this.proc.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.deliver(line);
        idx = this.buffer.indexOf("\n");
      }
    });
    this.proc.on("exit", () => {
      for (const [, p] of this.pending) p.reject(new Error("kernel exited"));
      this.pending.clear();
    });
  }

  private deliver(line: string): void {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      if (typeof msg.method === "string" && msg.method.startsWith("seasi.")) {
        this.onNotification?.({ method: msg.method, params: msg.params });
      }
      return;
    }
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  }

  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.start();
    const proc = this.proc;
    if (!proc?.stdin || proc.exitCode !== null) {
      return Promise.reject(new Error("kernel no arrancó (¿SEASI_CORE_DIR correcto y uv instalado?)"));
    }
    const id = this.nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  stop(): void {
    this.proc?.stdin?.end();
    this.proc?.kill("SIGTERM");
    this.proc = null;
  }
}
