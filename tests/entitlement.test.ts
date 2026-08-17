/** HARD suite: entitlements — cross-tenant rejection, forgeries, expiry. */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  EntitlementError,
  signEntitlement,
  verifyEntitlement,
  type Entitlement,
} from "../src/domains/entitlement/entitlement";

const keyPair = generateKeyPairSync("ed25519");
const attackerPair = generateKeyPairSync("ed25519");
const priv: string = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pub: string = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const attackerPriv: string = attackerPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

function ent(overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    schema_version: "seasi.entitlement/v1",
    tenant_id: "despacho.garcia",
    channel: "despacho-garcia",
    version: "1.0.0",
    expires_at: "2027-12-31T00:00:00.000Z",
    ...overrides,
  };
}

function bundle(e: Entitlement, key = priv): { blobB64: string; signatureB64: string } {
  return {
    blobB64: Buffer.from(JSON.stringify(e)).toString("base64"),
    signatureB64: signEntitlement(e, key),
  };
}

const base = {
  expectedTenantId: "despacho.garcia",
  expectedChannel: "despacho-garcia",
  now: new Date("2026-08-17T00:00:00Z"),
  publicKeyPem: pub,
};

describe("verifyEntitlement", () => {
  it("entitlement válido pasa y devuelve el objeto", () => {
    const e = verifyEntitlement({ ...bundle(ent()), ...base });
    expect(e.tenant_id).toBe("despacho.garcia");
  });

  it("PAQUETE CRUZADO: tenant equivocado se rechaza aunque la firma sea perfecta", () => {
    const b = bundle(ent({ tenant_id: "despacho.lopez", channel: "despacho-lopez" }));
    expect(() => verifyEntitlement({ ...b, ...base })).toThrowError(EntitlementError);
    try {
      verifyEntitlement({ ...b, ...base });
    } catch (err) {
      expect((err as EntitlementError).reason).toBe("wrong-tenant");
    }
  });

  it("forja con otra clave → bad-signature", () => {
    const b = bundle(ent(), attackerPriv);
    expect(() => verifyEntitlement({ ...b, ...base })).toThrowError(/firma/);
  });

  it("blob mutado post-firma → bad-signature", () => {
    const b = bundle(ent());
    const mutated = { ...ent(), tenant_id: "otro" };
    const badBlob = Buffer.from(JSON.stringify(mutated)).toString("base64");
    expect(() =>
      verifyEntitlement({ ...b, blobB64: badBlob, ...base }),
    ).toThrowError(EntitlementError);
  });

  it("expirado → expired (límite exacto inclusive)", () => {
    const e = ent({ expires_at: "2026-08-17T00:00:00.000Z" }); // == now
    const b = bundle(e);
    expect(() => verifyEntitlement({ ...b, ...base })).toThrowError(/expirado/);
  });

  it("formato ilegible / campos extra / versión mala → bad-format", () => {
    expect(() =>
      verifyEntitlement({
        blobB64: Buffer.from("{no-json").toString("base64"),
        signatureB64: "AAAA",
        ...base,
      }),
    ).toThrowError(/ilegible/);
    const extra = { ...ent(), bonus: true } as unknown as Entitlement;
    expect(() =>
      verifyEntitlement({ ...bundle(extra as never), ...base }),
    ).toThrowError(EntitlementError);
    const badVersion = ent({ version: "1.0" as never });
    expect(() => verifyEntitlement({ ...bundle(badVersion), ...base })).toThrowError(
      EntitlementError,
    );
  });

  it("canal equivocado → wrong-channel", () => {
    const b = bundle(ent({ channel: "beta-testers" }));
    try {
      verifyEntitlement({ ...b, ...base });
      expect.unreachable();
    } catch (err) {
      expect((err as EntitlementError).reason).toBe("wrong-channel");
    }
  });
});
