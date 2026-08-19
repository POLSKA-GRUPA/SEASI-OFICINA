#!/usr/bin/env node
/**
 * gen-contracts.mjs — TS side of the contract SSOT.
 *
 *   SEASI-CORE/schemas/v1/*.json  ->  src/contracts/gen/schemas.ts (zod)
 *
 * * Verifies every managed file digest against the kernel MANIFEST.json
 *   (same sha256 the Python side checks) — drift on either side fails here.
 * * Emits deterministic zod schemas for the subset of JSON-Schema draft-07
 *   the kernel contracts use. Never edit the generated file by hand.
 * * --check: recompute and exit non-zero on drift (CI gate).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(
  HERE,
  process.env.SEASI_SCHEMAS_DIR ?? "../../SEASI-CORE/schemas/v1",
);
const OUT_FILE = resolve(HERE, "../src/contracts/gen/schemas.ts");

const MANAGED_FILES = [
  "session.schema.json",
  "artifact.schema.json",
  "hitl-pause.schema.json",
  "shell-api.schema.json",
];
const UNMANAGED_REFS = ["tenant-scope.schema.json"]; // read-only, pre-existing

const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");
// Digests are canonical over LF: a Windows checkout (autocrlf) must not
// change what the MANIFEST recorded.
const canon = (t) => t.replace(/\r\n/g, "\n");

function loadAll() {
  if (!existsSync(SCHEMAS_DIR)) {
    console.error(`schemas dir not found: ${SCHEMAS_DIR}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(resolve(SCHEMAS_DIR, "MANIFEST.json"), "utf8"));
  const schemas = {};
  const digests = {};
  for (const name of MANAGED_FILES) {
    const text = canon(readFileSync(resolve(SCHEMAS_DIR, name), "utf8"));
    const digest = sha256(text);
    if (manifest.files[name] !== digest) {
      console.error(`MANIFEST mismatch for ${name}: kernel exports are stale`);
      process.exit(1);
    }
    schemas[name] = JSON.parse(text);
    digests[name] = digest;
  }
  for (const name of UNMANAGED_REFS) {
    schemas[name] = JSON.parse(readFileSync(resolve(SCHEMAS_DIR, name), "utf8"));
    digests[name] = sha256(canon(readFileSync(resolve(SCHEMAS_DIR, name), "utf8")));
  }
  return { manifest, schemas, digests };
}

const ident = (title) => title.replace(/[^A-Za-z0-9_]/g, "");

function propExpr(rawProp, required, refIndex) {
  let prop = rawProp;
  let forcedNullable = false;
  if (Array.isArray(prop.type)) {
    const nonNull = prop.type.filter((t) => t !== "null");
    forcedNullable = prop.type.includes("null");
    prop = { ...prop, type: nonNull.length === 1 ? nonNull[0] : undefined };
    if (nonNull.length !== 1) delete prop.type;
  }
  let expr;
  if (prop.$ref) {
    const target = Object.values(refIndex).find((s) => s.$id === prop.$ref);
    if (!target) throw new Error(`unresolved $ref ${prop.$ref}`);
    expr = `${ident(target.title)}Schema`;
  } else if (prop.enum) {
    if (prop.enum.every((v) => typeof v === "string")) {
      expr = `z.enum([${prop.enum.map((v) => JSON.stringify(v)).join(", ")}])`;
    } else {
      expr = `z.union([${prop.enum.map((v) => `z.literal(${JSON.stringify(v)})`).join(", ")}])`;
    }
  } else if (prop.const !== undefined) {
    expr = `z.literal(${JSON.stringify(prop.const)})`;
  } else if (prop.anyOf) {
    const main = prop.anyOf.find((v) => v.type !== "null");
    const nullable = prop.anyOf.some((v) => v.type === "null");
    expr = propExpr(main, true, refIndex);
    if (nullable) expr = `${expr}.nullable()`;
  } else if (prop.type === "array") {
    expr = `z.array(${propExpr(prop.items, true, refIndex)})`;
  } else if (prop.type === "object" && prop.properties) {
    expr = objectExpr(prop, refIndex);
  } else if (prop.type === "string") {
    expr = "z.string()";
    if (prop.format === "uuid") expr += ".uuid()";
    if (prop.format === "date-time") expr += ".datetime()";
    if (prop.minLength !== undefined) expr += `.min(${prop.minLength})`;
    if (prop.maxLength !== undefined) expr += `.max(${prop.maxLength})`;
    if (prop.pattern) {
      let pat = prop.pattern;
      if (pat.startsWith("^") && pat.endsWith("$")) {
        pat = pat.slice(1, -1);
      }
      const slashified = pat.replace(/\\/g, "\\\\").replace(/\//g, "\\/");
      expr += `.regex(/^${slashified}$/)`;
    }
  } else if (prop.type === "integer") {
    expr = "z.number().int()";
    if (prop.minimum !== undefined) expr += `.min(${prop.minimum})`;
    if (prop.maximum !== undefined) expr += `.max(${prop.maximum})`;
  } else if (prop.type === "number") {
    expr = "z.number()";
  } else if (prop.type === "boolean") {
    expr = "z.boolean()";
  } else {
    throw new Error(`unsupported schema fragment: ${JSON.stringify(prop).slice(0, 120)}`);
  }
  const optional = !required;
  if (forcedNullable && !expr.includes(".nullable()")) {
    expr = `${expr}.nullable()`;
  }
  if (prop.default !== undefined) {
    expr += `.default(${JSON.stringify(prop.default)})`;
  } else if (optional) {
    expr += ".optional()";
  }
  return expr;
}

function objectExpr(schema, refIndex) {
  const required = new Set(schema.required ?? []);
  const lines = Object.entries(schema.properties ?? {}).map(([name, prop]) => {
    const expr = propExpr(prop, required.has(name), refIndex);
    const safeName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : JSON.stringify(name);
    return `  ${safeName}: ${expr},`;
  });
  return ["z.object({", ...lines, "}).strict()"].join("\n");
}

function build() {
  const { schemas, digests } = loadAll();
  const order = ["tenant-scope.schema.json", ...MANAGED_FILES];
  const refIndex = Object.fromEntries(
    order.map((name) => [name, schemas[name]]),
  );
  const blocks = order.map((name) => {
    const schema = schemas[name];
    const nm = ident(schema.title);
    return `export const ${nm}Schema = ${objectExpr(schema, refIndex)};\n` +
      `export type ${nm} = z.infer<typeof ${nm}Schema>;`;
  });
  const digestConst = "export const CONTRACT_DIGESTS = " +
    JSON.stringify(digests, null, 2) + " as const;";
  return [
    "// AUTO-GENERATED by scripts/gen-contracts.mjs — DO NOT EDIT.",
    "// Source of truth: SEASI-CORE/schemas/v1 (pydantic -> JSON Schema).",
    "// Kernel side gate: tools/export_schemas.py --check (same digests).",
    'import { z } from "zod";',
    "",
    digestConst,
    "",
    ...blocks,
    "",
  ].join("\n");
}

const isCheck = process.argv.includes("--check");
const output = build();
if (isCheck) {
  if (!existsSync(OUT_FILE)) {
    console.error("generated contracts missing; run `npm run contracts`");
    process.exit(1);
  }
  if (canon(readFileSync(OUT_FILE, "utf8")) !== output) {
    console.error("contracts drifted; run `npm run contracts`");
    process.exit(1);
  }
  console.log("OK: TS contracts in sync with SEASI-CORE/schemas/v1");
} else {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, output, "utf8");
  console.log(`generated ${OUT_FILE}`);
}
