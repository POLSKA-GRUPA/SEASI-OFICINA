/**
 * Despacho vault: secrets live ONLY here (main process, OS keychain via the
 * injected crypto). Values never cross to the renderer; the kernel receives
 * them exclusively as environment variables (env-injection pattern audited
 * from real Electron agent apps — never in prompts, never in model context).
 */
import { z } from "zod";

/** Minimal crypto surface — Electron safeStorage in prod, fakes in tests. */
export interface VaultCrypto {
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

export interface VaultPersistence {
  load(): Record<string, Buffer> | null;
  save(entries: Record<string, Buffer>): void;
}

export const VAULT_NAMES = [
  "IMAP_HOST",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "DRIVE_RCLONE_REMOTE",
  "AEAT_CERT_PATH",
  "AEAT_CERT_PASSWORD",
  "GROQ_API_KEY",
  "ZAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MCP_TOKEN_URL",
  "MCP_CLIENT_ID",
  "MCP_CLIENT_SECRET",
  "MCP_REFRESH_TOKEN",
] as const;

export type VaultName = (typeof VAULT_NAMES)[number];

const NAME_SCHEMA = z.enum(VAULT_NAMES);

export class VaultError extends Error {
  constructor(readonly reason: "unknown-name" | "empty" | "io", message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export class VaultStore {
  private entries: Record<string, Buffer> = {};

  constructor(
    private readonly crypto: VaultCrypto,
    private readonly persistence: VaultPersistence,
  ) {
    this.entries = persistence.load() ?? {};
  }

  /** Renderer-safe metadata: names + presence, NEVER values. */
  list(): { name: string; set: boolean }[] {
    return VAULT_NAMES.map((name) => ({ name, set: name in this.entries }));
  }

  set(name: string, value: string): void {
    const parsed = NAME_SCHEMA.safeParse(name);
    if (!parsed.success) {
      throw new VaultError("unknown-name", `nombre de secret no permitido: ${name}`);
    }
    if (!value) throw new VaultError("empty", "el valor no puede estar vacío");
    this.entries[name] = this.crypto.encrypt(value);
    this.persist();
  }

  delete(name: string): boolean {
    if (!(name in this.entries)) return false;
    delete this.entries[name];
    this.persist();
    return true;
  }

  /** Env overlay for spawned processes (kernel / CLI adapters). */
  envOverlay(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, cipher] of Object.entries(this.entries)) {
      env[name] = this.crypto.decrypt(cipher);
    }
    return env;
  }

  has(name: string): boolean {
    return name in this.entries;
  }

  /** Defense in depth: accidental serialization must never leak secrets. */
  toJSON(): Record<string, string> {
    return { __redacted: "vault" };
  }

  private persist(): void {
    try {
      this.persistence.save({ ...this.entries });
    } catch (err) {
      throw new VaultError(
        "io",
        `no se pudo persistir el vault: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
