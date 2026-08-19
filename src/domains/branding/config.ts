/**
 * White-label tenant config: the three planes (brand / capabilities /
 * governance) validated fail-closed. Loaded from tenant/<id>/config.json
 * in userData; the shell refuses unknown fields silently accepted.
 */
import { z } from "zod";

export const BrandingSchema = z
  .object({
    name: z.string().min(1).max(64),
    tagline: z.string().max(140).optional(),
    logo: z.string().max(64).optional(),
    colors: z
      .object({
        primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        bg: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      })
      .strict()
      .optional(),
    email_domain: z.string().max(120).optional(),
  })
  .strict();

export const CapabilitiesSchema = z
  .object({
    modules: z.array(z.enum(["gestion_autonoma", "conta_laboral", "marketing"])),
    skills: z.array(z.string().min(1)).default([]),
    connectors: z
      .array(z.enum(["imap", "drive", "aeat", "telegram"]))
      .default([]),
  })
  .strict();

export const GovernanceSchema = z
  .object({
    hitl_required: z.array(z.string().min(1)).min(1),
    effect_policy: z.enum(["read-by-default", "write-with-approval"]),
    models_allowed: z.array(z.string().min(1)).min(1),
    budget_turns_default: z.number().int().min(1).max(10_000).default(64),
  })
  .strict();

export const TenantConfigSchema = z
  .object({
    schema_version: z.literal("seasi.tenant/v1"),
    tenant_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    branding: BrandingSchema,
    capabilities: CapabilitiesSchema,
    governance: GovernanceSchema,
  })
  .strict();

export type TenantConfig = z.infer<typeof TenantConfigSchema>;

export const DEFAULT_CONFIG: TenantConfig = {
  schema_version: "seasi.tenant/v1",
  tenant_id: "pgk",
  branding: {
    name: "PGK — Oficina cero",
    tagline: "Cliente cero de SEASI",
    colors: { primary: "#1f6feb", accent: "#f0b429", bg: "#0d1117" },
  },
  capabilities: {
    modules: ["gestion_autonoma", "conta_laboral"],
    skills: [],
    connectors: ["imap", "drive"],
  },
  governance: {
    hitl_required: ["filing.submit", "email.send", "conta.ledger.post"],
    effect_policy: "write-with-approval",
    models_allowed: ["groq/llama-3.3-70b-versatile", "zai/glm-5.1"],
    budget_turns_default: 64,
  },
};

export function validateConfig(raw: unknown): TenantConfig {
  return TenantConfigSchema.parse(raw);
}

/** CSS custom properties the renderer applies on load. */
export function cssVarsFor(config: TenantConfig): Record<string, string> {
  const c = config.branding.colors;
  return {
    "--brand-primary": c?.primary ?? "#1f6feb",
    "--brand-accent": c?.accent ?? "#f0b429",
    "--brand-bg": c?.bg ?? "#0d1117",
    "--brand-name": config.branding.name,
  };
}
