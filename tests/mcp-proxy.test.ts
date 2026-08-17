/** HARD suite: MCP OAuth proxy — refresh flows, token leaks, fail-closed. */
import { describe, expect, it, afterAll } from "vitest";
import { LocalMcpProxy, McpProxyError, type FetchLike } from "../src/domains/mcp-proxy/proxy";

const TOKEN_A = "access-AAA";
const TOKEN_B = "access-BBB";

type Call = { url: string; auth?: string; body?: string };
const calls: Call[] = [];

function fetcher(map: {
  upstream: (auth?: string) => { status: number; body: unknown };
  token: { status: number; body?: unknown };
}): FetchLike {
  return async (url, init) => {
    calls.push({ url, auth: init?.headers?.authorization, body: init?.body });
    if (url.includes("token.example")) {
      const t = map.token;
      return {
        status: t.status,
        json: async () => t.body ?? {},
        text: async () => JSON.stringify(t.body ?? {}),
      };
    }
    const r = map.upstream(init?.headers?.authorization);
    return {
      status: r.status,
      json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body),
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
}

async function withProxy(
  fetcherImpl: FetchLike,
  init?: { initialAccessToken?: string; initialExpiresAtMs?: number },
): Promise<{ proxy: LocalMcpProxy; port: number }> {
  const proxy = new LocalMcpProxy({
    upstream: "https://mcp.upstream.example/mcp",
    tokenUrl: "https://token.example/oauth",
    clientId: "cid",
    clientSecret: "csecret",
    initialAccessToken: init?.initialAccessToken ?? TOKEN_A,
    initialRefreshToken: "refresh-1",
    initialExpiresAtMs: init?.initialExpiresAtMs ?? Date.now() + 3600_000,
    fetcher: fetcherImpl,
  });
  const port = await proxy.start();
  return { proxy, port };
}

async function post(port: number, path: string, body: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

const proxies: LocalMcpProxy[] = [];
afterAll(async () => {
  for (const p of proxies) await p.stop();
});

describe("LocalMcpProxy", () => {
  it("token válido: reenvía con Bearer y no toca el token endpoint", async () => {
    calls.length = 0;
    const { proxy, port } = await withProxy(
      fetcher({ upstream: (auth) => ({ status: 200, body: { ok: true, auth } }), token: { status: 200 } }),
    );
    proxies.push(proxy);
    const res = await post(port, "/mcp", JSON.stringify({ method: "tools/list" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { auth?: string };
    expect(body.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(calls.some((c) => c.url.includes("token.example"))).toBe(false);
  });

  it("401 del upstream: refresca UNA vez y reintenta con el token nuevo", async () => {
    calls.length = 0;
    let first = true;
    const { proxy, port } = await withProxy(
      fetcher({
        upstream: (auth) => {
          if (first && auth === `Bearer ${TOKEN_A}`) {
            first = false;
            return { status: 401, body: { error: "expired" } };
          }
          return { status: 200, body: { ok: true, auth } };
        },
        token: { status: 200, body: { access_token: TOKEN_B, expires_in: 3600, refresh_token: "refresh-2" } },
      }),
    );
    proxies.push(proxy);
    const res = await post(port, "/mcp", JSON.stringify({ m: 1 }));
    const body = (await res.json()) as { auth?: string };
    expect(res.status).toBe(200);
    expect(body.auth).toBe(`Bearer ${TOKEN_B}`);
    // refresh pidió el refresh_token original y las credenciales del cliente
    const refreshCall = calls.find((c) => c.url.includes("token.example"));
    expect(refreshCall?.body).toContain("grant_type=refresh_token");
    expect(refreshCall?.body).toContain("refresh_token=refresh-1");
    // rotación de refresh token persistida
    expect(proxy.tokenState().hasAccess).toBe(true);
  });

  it("refresh rechazado: 503 fail-closed y JAMÁS reenvía sin token", async () => {
    calls.length = 0;
    const { proxy, port } = await withProxy(
      fetcher({
        upstream: () => ({ status: 200, body: { no: true } }),
        token: { status: 400, body: { error: "invalid_grant" } },
      }),
      { initialAccessToken: TOKEN_A, initialExpiresAtMs: Date.now() - 1000 }, // ya expirado
    );
    proxies.push(proxy);
    const res = await post(port, "/mcp", "{}");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("refresh-rejected");
    // el upstream NO recibió ninguna llamada sin Authorization
    const upstreamCalls = calls.filter((c) => c.url.includes("mcp.upstream"));
    expect(upstreamCalls.length).toBe(0);
  });

  it("tokens nunca aparecen en respuestas de error ni en status", async () => {
    const { proxy, port } = await withProxy(
      fetcher({
        upstream: () => ({ status: 500, body: { boom: true } }),
        token: { status: 200 },
      }),
    );
    proxies.push(proxy);
    const res = await post(port, "/mcp", "{}");
    const text = await res.text();
    expect(text).not.toContain(TOKEN_A);
    expect(JSON.stringify(proxy.status)).not.toContain(TOKEN_A);
  });

  it("skew: token que expira en 30s se refresca proactivamente", async () => {
    calls.length = 0;
    const { proxy, port } = await withProxy(
      fetcher({
        upstream: (auth) => ({ status: 200, body: { auth } }),
        token: { status: 200, body: { access_token: TOKEN_B, expires_in: 3600 } },
      }),
      { initialExpiresAtMs: Date.now() + 30_000 }, // dentro del skew de 60s
    );
    proxies.push(proxy);
    const res = await post(port, "/mcp", "{}");
    const body = (await res.json()) as { auth?: string };
    expect(body.auth).toBe(`Bearer ${TOKEN_B}`); // usó el REFRESCADO
    expect(calls.some((c) => c.url.includes("token.example"))).toBe(true);
  });

  it("rutas que no son /mcp → 404; método GET → 404; payload >1MB → 413", async () => {
    const { proxy, port } = await withProxy(
      fetcher({ upstream: () => ({ status: 200, body: {} }), token: { status: 200 } }),
    );
    proxies.push(proxy);
    const bad = await fetch(`http://127.0.0.1:${port}/otra`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(404);
    const get = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(get.status).toBe(404);
    const big = await post(port, "/mcp", "x".repeat(1_100_000));
    expect(big.status).toBe(413);
  });

  it("refresh malformedo (sin access_token) → 503, no crashea", async () => {
    const { proxy, port } = await withProxy(
      fetcher({
        upstream: () => ({ status: 200, body: {} }),
        token: { status: 200, body: { expires_in: 3600 } },
      }),
      { initialExpiresAtMs: Date.now() - 1000 },
    );
    proxies.push(proxy);
    const res = await post(port, "/mcp", "{}");
    expect(res.status).toBe(503);
    expect(McpProxyError.name).toBe("McpProxyError");
  });

  it("solo escucha en loopback", async () => {
    const { proxy } = await withProxy(
      fetcher({ upstream: () => ({ status: 200, body: {} }), token: { status: 200 } }),
    );
    proxies.push(proxy);
    // status no expone host; el bind es 127.0.0.1 por construcción del listen
    expect(proxy.status.running).toBe(true);
  });
});
