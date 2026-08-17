/**
 * Tenant entitlements: ed25519-signed right-to-install records.
 * The signed package of tenant A must NEVER install on tenant B —
 * cross-tenant rejection is the whole point of the commercial gate.
 */
import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../update/updater";

export const EntitlementSchema = z
  .object({
    schema_version: z.literal("seasi.entitlement/v1"),
    tenant_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    channel: z.string().min(1).max(64),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    expires_at: z.string().min(1),
  })
  .strict();

export type Entitlement = z.infer<typeof EntitlementSchema>;

export type EntitlementFailureReason =
  | "bad-format"
  | "bad-signature"
  | "wrong-tenant"
  | "wrong-channel"
  | "expired";

export class EntitlementError extends Error {
  constructor(readonly reason: EntitlementFailureReason, message: string) {
    super(message);
    this.name = "EntitlementError";
  }
}

export function signEntitlement(ent: Entitlement, privateKeyPem: string): string {
  return edSign(
    null,
    Buffer.from(canonicalJson(ent), "utf8"),
    createPrivateKey(privateKeyPem),
  ).toString("base64");
}

export function verifyEntitlement(args: {
  blobB64: string;
  signatureB64: string;
  expectedTenantId: string;
  expectedChannel: string;
  now: Date;
  publicKeyPem: string;
}): Entitlement {
  let ent: Entitlement;
  try {
    const parsed = JSON.parse(Buffer.from(args.blobB64, "base64").toString("utf8"));
    ent = EntitlementSchema.parse(parsed);
  } catch (err) {
    throw new EntitlementError("bad-format", `entitlement ilegible: ${String(err)}`);
  }

  let ok = false;
  try {
    ok = edVerify(
      null,
      Buffer.from(canonicalJson(JSON.parse(Buffer.from(args.blobB64, "base64").toString("utf8"))), "utf8"),
      createPublicKey(args.publicKeyPem),
      Buffer.from(args.signatureB64, "base64"),
    );
  } catch {
    ok = false;
  }
  if (!ok) throw new EntitlementError("bad-signature", "firma del entitlement inválida");

  if (ent.tenant_id !== args.expectedTenantId) {
    throw new EntitlementError("wrong-tenant", `paquete del tenant ${ent.tenant_id} en instalación ${args.expectedTenantId}`);
  }
  if (ent.channel !== args.expectedChannel) {
    throw new EntitlementError("wrong-channel", `canal ${ent.channel} ≠ ${args.expectedChannel}`);
  }
  if (new Date(ent.expires_at) <= args.now) {
    throw new EntitlementError("expired", `entitlement expirado ${ent.expires_at}`);
  }
  return ent;
}
