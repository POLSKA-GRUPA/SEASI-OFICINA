/**
 * Parity gate: the TS contracts must match the kernel schemas byte-for-byte
 * (same sha256 digests the Python CI checks) and validate real payloads.
 *
 * División documentada de responsabilidades:
 *   - Zod (aquí) valida la FORMA (campos, tipos, longitudes, enums, regex).
 *   - Pydantic + scope_guard (kernel) validan la SEMÁNTICA cross-field
 *     (decisión coherente, paths sin escape, expiración) — invariants que
 *     JSON Schema draft-07 no puede expresar y que llegan ya validadas en
 *     toda respuesta del kernel. La suite de integración real cubre esa
 *     semántica contra el kernel vivo.
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
  ShellApiManifestSchema,
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

describe("zod shape validation (semántica vive en el kernel)", () => {
  const tenant = { tenant_id: "pgk" };

  it("acepta sesión válida; default state=created; schema_version constante", () => {
    const ok = AgentSessionSchema.parse({
      tenant,
      client_ref: "B82211806",
      period_ref: "2026T3",
      adapter: "pi",
    });
    expect(ok.state).toBe("created");
    expect(ok.schema_version).toBe("seasi.session/v1");
    // campos requeridos ausentes → fallo
    expect(() =>
      AgentSessionSchema.parse({ tenant, client_ref: "X", period_ref: "2026T3" }),
    ).toThrow(); // sin adapter
  });

  it("artifact: hash 64-hex y kind dotted exigidos; shape de path string", () => {
    const base = {
      session_id: "00000000-0000-4000-8000-000000000001",
      tenant,
      kind: "aeat.model",
      content_hash: "a".repeat(64),
    };
    expect(() => ArtifactSchema.parse({ ...base, content_hash: "XYZ" })).toThrow();
    expect(() => ArtifactSchema.parse({ ...base, kind: "nodots" })).toThrow();
    expect(() => ArtifactSchema.parse({ ...base, extra: 1 })).toThrow(); // strict
    expect(ArtifactSchema.parse({ ...base, path: "clientes/X/f.pdf" }).path).toBe(
      "clientes/X/f.pdf",
    );
  });

  it("hitl pause: shape pending; enum status; digest 64-hex", () => {
    const base = {
      session_id: "00000000-0000-4000-8000-000000000001",
      tenant,
      capability_id: "filing.submit",
      payload_digest: "b".repeat(64),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    };
    const pause = HitlPauseSchema.parse(base);
    expect(pause.status).toBe("pending");
    expect(() => HitlPauseSchema.parse({ ...base, payload_digest: "corto" })).toThrow();
    expect(() =>
      HitlPauseSchema.parse({ ...base, status: "quantum" as never }),
    ).toThrow();
  });

  it("shell-api manifest valida la forma (longitudes/strict)", () => {
    const m = ShellApiManifestSchema.parse({
      schema_version: "seasi/shell-api/v1",
      methods: [
        { name: "seasi.version", effect_gated: false },
        { name: "seasi.hitl.decide", effect_gated: true },
      ],
    });
    expect(m.methods.length).toBe(2);
    // strict: campos extra prohibidos
    expect(() =>
      ShellApiManifestSchema.parse({
        schema_version: "seasi/shell-api/v1",
        methods: [{ name: "seasi.version", hacker: 1 }],
      }),
    ).toThrow();
    // NOTA SSOT: la gramática seasi.* y la unicidad cross-item son
    // field_validator/model_validator de pydantic → NO exportables a
    // draft-07. El kernel las aplica en runtime (-32601/-32602) y la suite
    // de integración real las cubre contra `uv run python -m seasi_core.rpc`.
  });

  it("tenant ids obedecen la gramática del kernel", () => {
    expect(TenantScopeSchema.parse({ tenant_id: "pgk" }).tenant_id).toBe("pgk");
    expect(() => TenantScopeSchema.parse({ tenant_id: "PGK!" })).toThrow();
  });
});
