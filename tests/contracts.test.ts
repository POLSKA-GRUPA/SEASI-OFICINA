/**
 * Parity gate: the TS contracts must match the kernel schemas byte-for-byte
 * (same sha256 digests the Python CI checks) and validate real payloads.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AgentSessionSchema,
  ArtifactSchema,
  CONTRACT_DIGESTS,
  HitlPauseSchema,
  TenantScopeSchema,
} from "../src/contracts/gen/schemas";

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const hereDir = new URL(".", import.meta.url).pathname;
const schemasDir = resolve(
  hereDir,
  process.env.SEASI_SCHEMAS_DIR ?? "../../SEASI-CORE/schemas/v1",
);

describe("contract parity (kernel <-> shell)", () => {
  it("managed digests match SEASI-CORE/schemas/v1 on disk", () => {
    for (const [name, digest] of Object.entries(CONTRACT_DIGESTS)) {
      const onDisk = sha256(readFileSync(resolve(schemasDir, name), "utf8"));
      expect(onDisk, `${name} drifted`).toBe(digest);
    }
  });

  it("MANIFEST.json of the kernel lists the same digests", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(schemasDir, "MANIFEST.json"), "utf8"),
    ) as { files: Record<string, string> };
    for (const [name, digest] of Object.entries(manifest.files)) {
      expect(CONTRACT_DIGESTS[name as keyof typeof CONTRACT_DIGESTS]).toBe(digest);
    }
  });
});

describe("zod contracts validate like pydantic", () => {
  const tenant = { tenant_id: "pgk" };

  it("accepts a valid session and rejects a bad period", () => {
    const ok = AgentSessionSchema.parse({
      tenant,
      client_ref: "B82211806",
      period_ref: "2026T3",
      adapter: "pi",
    });
    expect(ok.state).toBe("created");
    expect(() =>
      AgentSessionSchema.parse({ tenant, client_ref: "X", period_ref: "2026T9", adapter: "pi" }),
    ).toThrow();
  });

  it("rejects artifact path escapes at the contract level", () => {
    const base = {
      session_id: "00000000-0000-0000-0000-000000000001",
      tenant,
      kind: "aeat.model",
      content_hash: "a".repeat(64),
    };
    expect(() => ArtifactSchema.parse({ ...base, path: "/etc/passwd" })).toThrow();
    expect(() => ArtifactSchema.parse({ ...base, path: "a/../b.pdf" })).toThrow();
    expect(ArtifactSchema.parse({ ...base, path: "clientes/X/f.pdf" }).kind).toBe("aeat.model");
  });

  it("hitl pause requires consistent decision fields", () => {
    const base = {
      session_id: "00000000-0000-0000-0000-000000000001",
      tenant,
      capability_id: "filing.submit",
      payload_digest: "b".repeat(64),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    expect(HitlPauseSchema.parse(base).status).toBe("pending");
    expect(() => HitlPauseSchema.parse({ ...base, decided_by: "kenyi" })).toThrow();
  });

  it("tenant ids obey the kernel grammar", () => {
    expect(TenantScopeSchema.parse({ tenant_id: "pgk" }).tenant_id).toBe("pgk");
    expect(() => TenantScopeSchema.parse({ tenant_id: "PGK!" })).toThrow();
  });
});
