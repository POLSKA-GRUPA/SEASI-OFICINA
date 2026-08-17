/**
 * SEASI Despacho — Electron main process.
 *
 * Security posture (non-negotiable, see SEASI-CORE openspec sea-sic-core-v0):
 *   - sandbox: true, contextIsolation: true, nodeIntegration: false
 *   - ONE namespaced IPC channel (`seasi:rpc`) bridging to the kernel
 *   - The kernel is spawned as `uv run python -m seasi_core.rpc` (JSON-RPC
 *     over stdio). No shell interpolation; env carries SEASI_DB / SEASI_ROOT
 *     under the app's userData dir (tenant-scoped workspace).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain, BrowserWindow } from "electron";

type Pending = { resolve: (value: unknown) => void; reject: (e: Error) => void };
let kernelProc: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const backpressure: string[] = [];
let buffer = "";

function kernelEnv(): { SEASI_DB: string; SEASI_ROOT: string } {
  const home = app.getPath("userData");
  const db = join(home, "ledger.db");
  const root = join(home, "workspace");
  mkdirSync(root, { recursive: true });
  return { SEASI_DB: db, SEASI_ROOT: root };
}

function startKernel(): ChildProcess {
  if (kernelProc && kernelProc.exitCode === null) return kernelProc;
  const env = kernelEnv();
  buffer = "";
  kernelProc = spawn(
    "uv",
    ["run", "--project", process.env.SEASI_CORE_DIR ?? "../SEASI-CORE",
      "python", "-m", "seasi_core.rpc"],
    { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  kernelProc.stdout?.setEncoding("utf8");
  kernelProc.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) deliver(line);
      idx = buffer.indexOf("\n");
    }
  });
  kernelProc.on("exit", () => {
    for (const [, p] of pending) p.reject(new Error("kernel exited"));
    pending.clear();
  });
  return kernelProc;
}

function deliver(line: string): void {
  let msg: { id?: number | string; result?: unknown; error?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return; // visual log noise; business channel is JSON-RPC only
  }
  const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  if (msg.error) {
    waiter.reject(new Error(JSON.stringify(msg.error)));
  } else {
    waiter.resolve(msg.result);
  }
  // Flush any requests that arrived while the kernel was starting.
  const next = backpressure.shift();
  if (next) void sendRaw(next.payload, next.id);
}

type Queued = { payload: string; id: number };

function sendRaw(payload: string, id: number): Promise<unknown> {
  const proc = startKernel();
  const stdin = proc.stdin;
  if (!stdin) return Promise.reject(new Error("kernel stdin unavailable"));
  stdin.write(payload + "\n");
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function rpcCall(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
  const proc = startKernel();
  if (!proc.stdin || proc.exitCode !== null) {
    return Promise.reject(new Error("kernel not running"));
  }
  if (pending.size > 0) {
    // one in-flight call at a time in v0 (kernel processes lines in order)
    return new Promise<unknown>((resolve, reject) => {
      backpressure.push({ payload, id });
      pending.set(id, { resolve, reject });
    });
  }
  return sendRaw(payload, id);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "SEASI Despacho",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  ipcMain.handle("seasi:rpc", (_evt, method: string, params?: Record<string, unknown>) =>
    rpcCall(method, params),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  kernelProc?.kill();
});
