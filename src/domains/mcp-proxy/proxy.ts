/**
 * MCP OAuth local proxy (patrón mcp-auth-proxy auditado en apps reales).
 *
 * Tokens OAuth viven SOLO en este proceso (del vault). Los agentes hablan
 * con 127.0.0.1:<puerto>; el proxy añade el Bearer y refresca en 401.
 * Reglas duras:
 *   - tokens jamás en logs, errores o respuestas
 *   - refresh con skew de 60s antes de la expiración
 *   - fallo de refresh ⇒ 503 fail-closed (nunca reenvía sin token)
 *   - solo escucha en loopback
 */
import { createServer, type Server } from "node:http";
import { z } from "zod";

export const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
  })
  .passthrough();

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export class McpProxyError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(message);
    this.name = "McpProxyError";
  }
}

const SKEW_MS = 60_000;

export class LocalMcpProxy {
  private accessToken: string | null;
  private refreshToken: string;
  private expiresAt = 0;
  private server: Server | null = null;
  private port = 0;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly cfg: {
      upstream: string;
      tokenUrl: string;
      clientId: string;
      clientSecret: string;
      initialAccessToken: string;
      initialRefreshToken: string;
      initialExpiresAtMs?: number;
      fetcher: FetchLike;
    },
  ) {
    this.accessToken = cfg.initialAccessToken;
    this.refreshToken = cfg.initialRefreshToken;
    this.expiresAt = cfg.initialExpiresAtMs ?? 0;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    return new Promise((resolvePromise) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolvePromise(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server?.close(() => r()));
    this.server = null;
    this.port = 0;
  }

  get status(): { running: boolean; port: number; upstream: string } {
    return { running: this.server !== null, port: this.port, upstream: this.cfg.upstream };
  }

  /** Visible para tests: nunca expone el valor del token. */
  tokenState(): { hasAccess: boolean; expiresAt: number } {
    return { hasAccess: this.accessToken !== null, expiresAt: this.expiresAt };
  }

  private async handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not-found" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
      if (chunks.reduce((n, c) => n + c.byteLength, 0) > 1_000_000) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload-too-large" }));
        return;
      }
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      const out = await this.forward(body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    } catch (err) {
      const status = err instanceof McpProxyError ? err.status : 502;
      const reason = err instanceof McpProxyError ? err.reason : "upstream-error";
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: reason })); // NUNCA el mensaje crudo (podría llevar token)
    }
  }

  private async ensureToken(): Promise<string> {
    const stillValid = this.accessToken !== null && Date.now() < this.expiresAt - SKEW_MS;
    if (stillValid && this.accessToken) return this.accessToken;
    await this.refresh();
    if (this.accessToken === null) {
      throw new McpProxyError(503, "no-token", "refresh failed");
    }
    return this.accessToken;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const res = await this.cfg.fetcher(this.cfg.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: this.refreshToken,
            client_id: this.cfg.clientId,
            client_secret: this.cfg.clientSecret,
          }).toString(),
        });
        if (res.status !== 200) {
          this.accessToken = null; // fail-closed
          throw new McpProxyError(503, "refresh-rejected", `token endpoint ${res.status}`);
        }
        const parsed = TokenResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          this.accessToken = null;
          throw new McpProxyError(503, "refresh-malformed", "token response invalid");
        }
        this.accessToken = parsed.data.access_token;
        this.expiresAt = Date.now() + parsed.data.expires_in * 1000;
        if (parsed.data.refresh_token) this.refreshToken = parsed.data.refresh_token;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async forward(body: string, retried = false): Promise<{ status: number; body: string }> {
    const token = await this.ensureToken();
    const res = await this.cfg.fetcher(this.cfg.upstream, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body,
    });
    if (res.status === 401 && !retried) {
      this.accessToken = null;
      this.expiresAt = 0;
      return this.forward(body, true);
    }
    if (res.status >= 400) {
      return { status: res.status, body: JSON.stringify({ error: "upstream", status: res.status }) };
    }
    return { status: res.status, body: await res.text() };
  }
}
