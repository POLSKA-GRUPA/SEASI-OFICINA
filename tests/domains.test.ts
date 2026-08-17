/** HARD suite: backup hash-anchor + restore; vault no-leak; branding fail-closed. */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BackupError,
  createBackup,
  listBackups,
  restoreBackup,
  verifyBackup,
} from "../src/domains/backup/backup";
import { VaultStore, VaultError, type VaultCrypto, type VaultPersistence } from "../src/domains/vault/store";
import { DEFAULT_CONFIG, validateConfig } from "../src/domains/branding/config";

// ------------------------------------------------------------------ backup

function setupHome() {
  const dir = mkdtempSync(join(tmpdir(), "seasi-backup-"));
  const ledgerDb = join(dir, "ledger.db");
  writeFileSync(ledgerDb, Buffer.from("sqlite-ish-bytes-v1"));
  writeFileSync(`${ledgerDb}-wal`, Buffer.from("wal-bytes"));
  const brainDir = join(dir, "brain");
  mkdirSync(brainDir);
  writeFileSync(join(brainDir, "BRAIN.md"), "# Brain\n→ [[Mission]]");
  writeFileSync(join(brainDir, "roadmap.md"), "## Todo\n- [ ] algo");
  const tenantConfig = join(dir, "tenant.json");
  writeFileSync(tenantConfig, JSON.stringify(DEFAULT_CONFIG));
  const backupsRoot = join(dir, "backups");
  return { dir, ledgerDb, brainDir, tenantConfig, backupsRoot };
}

describe("backup create/verify/restore", () => {
  it("roundtrip completo con ancla de hashes", () => {
    const home = setupHome();
    const manifest = createBackup({ ...home, nowIso: "2026-08-17T16:00:00Z", id: "bk-1" });
    expect(manifest.files.length).toBeGreaterThanOrEqual(4); // db+wal+mds+tenant
    const stored = verifyBackup(join(home.backupsRoot, "bk-1"));
    expect(stored.files.length).toBe(manifest.files.length);
    expect(listBackups(home.backupsRoot)).toEqual(["bk-1"]);

    // destruir origen y restaurar
    rmSync(home.ledgerDb);
    rmSync(home.brainDir, { recursive: true });
    restoreBackup({ backupDir: join(home.backupsRoot, "bk-1"), ...home });
    expect(readFileSync(home.ledgerDb).toString()).toBe("sqlite-ish-bytes-v1");
    expect(existsSync(join(home.brainDir, "roadmap.md"))).toBe(true);
  });

  it("corrupción de un byte detectada al verificar", () => {
    const home = setupHome();
    createBackup({ ...home, nowIso: "2026-08-17T16:00:00Z", id: "bk-2" });
    const dbFile = join(home.backupsRoot, "bk-2", "ledger.db");
    const bytes = readFileSync(dbFile);
    bytes[0] = bytes[0]! ^ 0xff;
    writeFileSync(dbFile, bytes);
    expect(() => verifyBackup(join(home.backupsRoot, "bk-2"))).toThrow(BackupError);
  });

  it("manifest ausente o ilegible → error tipado", () => {
    const home = setupHome();
    createBackup({ ...home, nowIso: "x", id: "bk-3" });
    rmSync(join(home.backupsRoot, "bk-3", "manifest.json"));
    expect(() => verifyBackup(join(home.backupsRoot, "bk-3"))).toThrow(/manifest/);
    mkdirSync(join(home.backupsRoot, "bk-4"), { recursive: true });
    writeFileSync(join(home.backupsRoot, "bk-4", "manifest.json"), "{no json");
    expect(() => verifyBackup(join(home.backupsRoot, "bk-4"))).toThrow(BackupError);
  });

  it("truncar el ledger ANTES del backup queda anclado por el hash", () => {
    const home = setupHome();
    createBackup({ ...home, nowIso: "x", id: "bk-a" });
    // truncamiento in-place posterior en origen + nuevo backup = hash distinto
    writeFileSync(home.ledgerDb, Buffer.from("sqlite-ish-byt")); // quitamos 2 bytes
    createBackup({ ...home, nowIso: "x", id: "bk-b" });
    const a = verifyBackup(join(home.backupsRoot, "bk-a"));
    const b = verifyBackup(join(home.backupsRoot, "bk-b"));
    expect(a.files.find((f) => f.path === "ledger.db")!.sha256)
      .not.toBe(b.files.find((f) => f.path === "ledger.db")!.sha256);
  });
});

// ------------------------------------------------------------------ vault

class FakeCrypto implements VaultCrypto {
  encrypt(p: string): Buffer { return Buffer.from(`enc:${p}`, "utf8"); }
  decrypt(c: Buffer): string { return c.toString("utf8").replace(/^enc:/, ""); }
}

class MemPersistence implements VaultPersistence {
  store: Record<string, Buffer> | null = null;
  load() { return this.store; }
  save(entries: Record<string, Buffer>) { this.store = { ...entries }; }
}

function makeVault() {
  const persistence = new MemPersistence();
  return { vault: new VaultStore(new FakeCrypto(), persistence), persistence };
}

describe("vault", () => {
  it("valores NUNCA aparecen en list ni en serialización", () => {
    const { vault } = makeVault();
    vault.set("IMAP_PASSWORD", "super-secreto-123");
    const listed = JSON.stringify(vault.list());
    expect(listed).not.toContain("super-secreto-123");
    expect(JSON.stringify(vault)).not.toContain("super-secreto");
    expect(vault.toJSON()).toEqual({ __redacted: "vault" });
  });

  it("env overlay descifra solo para procesos", () => {
    const { vault } = makeVault();
    vault.set("GROQ_API_KEY", "gsk-abc");
    expect(vault.envOverlay()).toEqual({ GROQ_API_KEY: "gsk-abc" });
  });

  it("nombres fuera de la lista → fail closed", () => {
    const { vault } = makeVault();
    expect(() => vault.set("EVIL_ENV_VAR", "x")).toThrow(VaultError);
    expect(() => vault.set("IMAP_PASSWORD", "")).toThrow(VaultError);
  });

  it("persistencia roundtrip y delete", () => {
    const { vault, persistence } = makeVault();
    vault.set("ZAI_API_KEY", "z-1");
    const revived = new VaultStore(new FakeCrypto(), persistence);
    expect(revived.envOverlay()).toEqual({ ZAI_API_KEY: "z-1" });
    expect(revived.delete("ZAI_API_KEY")).toBe(true);
    expect(revived.delete("ZAI_API_KEY")).toBe(false);
    expect(new VaultStore(new FakeCrypto(), persistence).envOverlay()).toEqual({});
  });
});

// ------------------------------------------------------------------ branding

describe("branding fail-closed", () => {
  it("default válido; extras prohibidos", () => {
    expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, sorpresa: true })).toThrow();
  });

  it("color inválido, sin hitl_required o modelos vacíos → rechazo", () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, branding: { ...DEFAULT_CONFIG.branding, colors: { primary: "rojo" } as unknown as "#rrggbb" } })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, governance: { ...DEFAULT_CONFIG.governance, hitl_required: [] } })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, governance: { ...DEFAULT_CONFIG.governance, models_allowed: [] } })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, capabilities: { ...DEFAULT_CONFIG.capabilities, modules: ["inventado" as never] } })).toThrow();
  });

  it("tenant_id obedece la gramática del kernel", () => {
    expect(() => validateConfig({ ...DEFAULT_CONFIG, tenant_id: "PGK!" })).toThrow();
    expect(() => validateConfig({ ...DEFAULT_CONFIG, tenant_id: "despacho.garcia" })).not.toThrow();
  });
});
