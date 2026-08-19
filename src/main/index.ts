/**
 * La Oficina (SEASI) — Electron main process.
 *
 * Security posture (openspec sea-sic-core-v0, non-negotiable):
 *   - sandbox: true, contextIsolation: true, nodeIntegration: false
 *   - ONE ipc channel for the kernel (`seasi:rpc`) + namespaced local
 *     channels (`shell:vault:*`, `shell:brain:*`, `shell:backup:*`,
 *     `shell:update:*`, `shell:branding:get`, `shell:diagnostics:export`)
 *   - vault values NEVER cross the IPC boundary (names + presence only);
 *     they reach the kernel via process env (env-injection)
 *   - kernel business channel is JSON-RPC over stdio; terminal output is
 *     presentation-only and never parsed for state
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { app, ipcMain, safeStorage, BrowserWindow, dialog } from "electron";
import { VaultStore, VaultError, type VaultPersistence } from "../domains/vault/store";
import {
  DEFAULT_CONFIG,
  validateConfig,
  type TenantConfig,
} from "../domains/branding/config";
import {
  createBackup,
  listBackups,
  verifyBackup,
  BackupError,
} from "../domains/backup/backup";
import { checkForUpdate, UpdateError } from "../domains/update/updater";
import { LocalMcpProxy } from "../domains/mcp-proxy/proxy";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let kernelProc: ChildProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
const queue: string[] = [];
let buffer = "";
let vault: VaultStore | null = null;

const PUBLIC_KEY_PATH = join(app.getPath("userData") ?? ".", "update-public.pem");

function paths() {
  const home = app.getPath("userData");
  return {
    home,
    db: join(home, "ledger.db"),
    root: join(home, "workspace"),
    brain: join(home, "brain"),
    backups: join(home, "backups"),
    tenant: join(home, "tenant.json"),
    diagnostics: join(home, "diagnostics"),
  } as const;
}

// ---------------------------------------------------------------- kernel rpc

function kernelEnv(): Record<string, string> {
  const p = paths();
  mkdirSync(p.root, { recursive: true });
  const overlay = vault?.envOverlay() ?? {};
  return { SEASI_DB: p.db, SEASI_ROOT: p.root, ...overlay };
}

function startKernel(): ChildProcess {
  if (kernelProc && kernelProc.exitCode === null) return kernelProc;
  const coreDir = process.env.SEASI_CORE_DIR ?? join(app.getAppPath(), "..", "SEASI-CORE");
  buffer = "";
  kernelProc = spawn(
    "uv",
    ["run", "--project", coreDir, "python", "-m", "seasi_core.rpc"],
    { env: { ...process.env, ...kernelEnv() }, stdio: ["pipe", "pipe", "pipe"] },
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
    queue.length = 0;
  });
  return kernelProc;
}

function deliver(line: string): void {
  let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // Server notification (streaming en vivo): broadcast a todas las ventanas.
  if (msg.id === undefined || msg.id === null) {
    if (typeof msg.method === "string" && msg.method.startsWith("seasi.")) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("shell:session:event", { method: msg.method, params: msg.params });
      }
    }
    return;
  }
  const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
  const waiter = pending.get(id);
  if (!waiter) return;
  pending.delete(id);
  if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
  else waiter.resolve(msg.result);
  const nextPayload = queue.shift();
  if (nextPayload !== undefined) {
    const proc = startKernel();
    proc.stdin?.write(nextPayload + "\n");
  }
}

function rpcCall(
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });
  const proc = startKernel();
  if (!proc.stdin || proc.exitCode !== null) {
    return Promise.reject(new Error("kernel not running"));
  }
  if (pending.size > 0 || queue.length > 0) {
    return new Promise<unknown>((resolve, reject) => {
      queue.push(payload);
      pending.set(id, { resolve, reject });
    });
  }
  proc.stdin.write(payload + "\n");
  return new Promise<unknown>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

// ---------------------------------------------------------------- vault glue

class SafeStoragePersistence implements VaultPersistence {
  constructor(private readonly file: string) {}
  load(): Record<string, Buffer> | null {
    if (!existsSync(this.file)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
      const out: Record<string, Buffer> = {};
      for (const [k, v] of Object.entries(raw)) out[k] = Buffer.from(v, "base64");
      return out;
    } catch {
      return null;
    }
  }
  save(entries: Record<string, Buffer>): void {
    const raw: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) raw[k] = v.toString("base64");
    writeFileSync(this.file, JSON.stringify(raw), { mode: 0o600 });
  }
}

function getVault(): VaultStore {
  if (vault === null) {
    const cryptoImpl = {
      encrypt: (plain: string): Buffer =>
        safeStorage.isEncryptionAvailable()
          ? safeStorage.encryptString(plain)
          : Buffer.from(plain, "utf8"), // dev fallback, never in prod builds
      decrypt: (cipher: Buffer): string =>
        safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(cipher)
          : cipher.toString("utf8"),
    };
    vault = new VaultStore(
      cryptoImpl,
      new SafeStoragePersistence(join(paths().home, "vault.bin")),
    );
  }
  return vault;
}

// ---------------------------------------------------------------- branding

function loadTenantConfig(): TenantConfig {
  const file = paths().tenant;
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return DEFAULT_CONFIG;
  }
  try {
    return validateConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (err) {
    console.error("[tenant] config inválida, usando default:", err);
    return DEFAULT_CONFIG;
  }
}

// ---------------------------------------------------------------- window

function createWindow(): void {
  const config = loadTenantConfig();
  const iconPath = join(__dirname, "../../build/icon.png");
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    title: `La Oficina — ${config.branding.name}`,
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("console-message", (_e, _level, message) => {
    if (/error|failed|uncaught/i.test(message)) {
      console.error(`[renderer] ${message}`);
    }
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

let mcpProxy: LocalMcpProxy | null = null;

async function startMcpProxyIfConfigured(): Promise<void> {
  if (mcpProxy) return;
  const upstream = process.env.SEASI_MCP_UPSTREAM;
  if (!upstream) return; // fase interna: opcional
  const env = getVault().envOverlay();
  if (!env.MCP_TOKEN_URL || !env.MCP_CLIENT_ID || !env.MCP_CLIENT_SECRET || !env.MCP_REFRESH_TOKEN) {
    console.error("[mcp] SEASI_MCP_UPSTREAM activo pero faltan credenciales MCP_* en el vault");
    return;
  }
  mcpProxy = new LocalMcpProxy({
    upstream,
    tokenUrl: env.MCP_TOKEN_URL,
    clientId: env.MCP_CLIENT_ID,
    clientSecret: env.MCP_CLIENT_SECRET,
    initialAccessToken: "bootstrap", // fuerza refresh antes del primer forward
    initialRefreshToken: env.MCP_REFRESH_TOKEN,
    fetcher: async (url, init) => {
      const res = await globalThis.fetch(url, init);
      return {
        status: res.status,
        json: async () => await res.json(),
        text: async () => await res.text(),
      };
    },
  });
  await mcpProxy.start();
  console.error(`[mcp] proxy escuchando en 127.0.0.1:${mcpProxy.status.port} → ${upstream}`);
}

// ---------------------------------------------------------------- bootstrap

app.whenReady().then(() => {
  const p = paths();
  mkdirSync(p.brain, { recursive: true });
  mkdirSync(p.backups, { recursive: true });
  getVault();

  // kernel channel (single, auditable)
  ipcMain.handle(
    "seasi:rpc",
    (_evt, method: string, params?: Record<string, unknown>) => rpcCall(method, params),
  );

  // vault: metadata only — values never leave this process
  ipcMain.handle("shell:vault:list", () => getVault().list());
  ipcMain.handle("shell:vault:set", (_e, name: string, value: string) => {
    getVault().set(name, value);
    return { ok: true };
  });
  ipcMain.handle("shell:vault:delete", (_e, name: string) => getVault().delete(name));

  // brain: scoped .md IO under userData/brain
  ipcMain.handle("shell:brain:list", () => {
    return readdirSync(p.brain).filter((f) => f.endsWith(".md")).sort();
  });
  ipcMain.handle("shell:brain:read", (_e, name: string) => {
    if (!/^[A-Za-z0-9 _-]+\.md$/.test(name)) throw new Error("nombre inválido");
    return readFileSync(join(p.brain, name), "utf8");
  });
  ipcMain.handle("shell:brain:write", (_e, name: string, content: string) => {
    if (!/^[A-Za-z0-9 _-]+\.md$/.test(name)) throw new Error("nombre inválido");
    writeFileSync(join(p.brain, name), content, "utf8");
    return { ok: true };
  });

  // backups
  ipcMain.handle("shell:backup:create", () => {
    const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    return createBackup({
      backupsRoot: p.backups,
      ledgerDb: p.db,
      brainDir: p.brain,
      tenantConfig: p.tenant,
      nowIso: new Date().toISOString(),
      id,
    });
  });
  ipcMain.handle("shell:backup:list", () => listBackups(p.backups));
  ipcMain.handle("shell:backup:verify", (_e, id: string) => {
    if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error("id inválido");
    return verifyBackup(join(p.backups, id));
  });

  // updates: check only; apply stays a user-driven manual step in v0
  ipcMain.handle("shell:update:check", async () => {
    const feedUrl = process.env.SEASI_UPDATE_FEED;
    if (!feedUrl || !existsSync(PUBLIC_KEY_PATH)) {
      return { status: "not-configured" as const };
    }
    try {
      const plan = await checkForUpdate({
        feedUrl,
        currentVersion: app.getVersion(),
        channel: loadTenantConfig().tenant_id,
        publicKeyPem: readFileSync(PUBLIC_KEY_PATH, "utf8"),
        fetcher: async (url) => {
          const res = await globalThis.fetch(url);
          return { ok: res.ok, body: async () => await res.text() };
        },
      });
      return plan === null
        ? { status: "up-to-date" as const }
        : { status: "available" as const, version: plan.manifest.version };
    } catch (err) {
      if (err instanceof UpdateError) return { status: "error" as const, reason: err.reason, message: err.message };
      throw err;
    }
  });

  // branding
  ipcMain.handle("shell:branding:get", () => loadTenantConfig());

  // mcp proxy (estado solamente; tokens jamás cruzan IPC)
  ipcMain.handle("shell:mcp:status", () =>
    mcpProxy ? mcpProxy.status : { running: false, port: 0, upstream: null },
  );
  void startMcpProxyIfConfigured();

  // diagnostics: local export package (user decides what to share)
  ipcMain.handle("shell:diagnostics:export", async () => {
    const dir = join(p.diagnostics, `diag-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    if (existsSync(p.db)) {
      copyFileSync(p.db, join(dir, "ledger.db"));
      if (existsSync(`${p.db}-wal`)) copyFileSync(`${p.db}-wal`, join(dir, "ledger.db-wal"));
    }
    writeFileSync(
      join(dir, "README.txt"),
      [
        "Paquete de diagnóstico La Oficina.",
        "Contiene SOLO el ledger local (eventos del kernel).",
        "Revísalo antes de compartirlo con nadie; no contiene secrets del vault.",
      ].join("\n"),
      "utf8",
    );
    const chosen = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (!chosen.canceled && chosen.filePaths[0]) {
      const dest = join(chosen.filePaths[0]!, `seasi-diagnostico-${Date.now()}`);
      mkdirSync(dest, { recursive: true });
      for (const f of ["ledger.db", "ledger.db-wal", "README.txt"] as const) {
        const src = join(dir, f);
        if (existsSync(src)) copyFileSync(src, join(dest, f));
      }
      rmSync(dir, { recursive: true, force: true });
      return { exported: true, path: dest };
    }
    return { exported: false, path: dir };
  });

  createWindow();

  // utilidad: SEASI_SCREENSHOT=<ruta> captura la ventana tras 5s y sale (docs/smoke)
  const shot = process.env.SEASI_SCREENSHOT;
  if (shot) {
    const win = BrowserWindow.getAllWindows()[0];
    setTimeout(() => {
      win?.webContents.capturePage().then((img) => {
        writeFileSync(shot, img.toPNG());
        console.error(`[screenshot] ${shot}`);
        app.quit();
      }).catch((e: unknown) => { console.error(`[screenshot] fallo: ${String(e)}`); app.quit(); });
    }, 5000);
  }

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

export { VaultError, BackupError };
