#!/usr/bin/env bun
/**
 * Generates `src/generated/hook-contract.ts` — Zod schemas for Arcade's hook
 * webhook contract — from the vendored OpenAPI document in `vendor/`.
 *
 * Why generate rather than hand-write: this is somebody else's contract. A
 * hand-written copy drifts the moment Arcade adds a field, and spike 02 showed
 * that a malformed hook response is indistinguishable from a dead hook server
 * (`-32603 ... tool access policy service could not be reached`). Generated
 * output can be diffed against upstream on demand; a hand-written one cannot.
 *
 * Why a generator in this repo rather than `openapi-typescript` et al.: we need
 * *runtime* validators, not just types — `apps/hooks` parses inbound payloads
 * and must validate its own responses. The subset of OpenAPI this document uses
 * is small and fully covered below, and `test/generator.test.ts` pins every
 * construct in it.
 *
 *   bun run generate         write src/generated/hook-contract.ts
 *   bun run generate:check   fail if the committed file is stale
 *   bun run fetch            refresh the vendored spec from upstream
 *
 * Only the constructs actually present in the vendored document are supported.
 * Anything else throws with the JSON pointer, so an upstream change that needs
 * generator work fails loudly at generation time instead of quietly emitting a
 * validator that accepts everything.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const SPEC_PATH = join(
  PACKAGE_ROOT,
  "vendor",
  "logic-extensions-http-1.0.schema.yaml",
);
const OUT_PATH = join(PACKAGE_ROOT, "src", "generated", "hook-contract.ts");

const UPSTREAM_RAW =
  "https://raw.githubusercontent.com/ArcadeAI/schemas/main/logic_extensions/http/1.0/schema.yaml";

// ---------------------------------------------------------------------------
// The slice of OpenAPI 3.0 this document uses
// ---------------------------------------------------------------------------

interface OpenApiSchema {
  $ref?: string;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  items?: OpenApiSchema;
}

interface OpenApiDocument {
  info: { version: string; title: string };
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: { schemas: Record<string, OpenApiSchema> };
}

// ---------------------------------------------------------------------------
// Emitting Zod expressions
// ---------------------------------------------------------------------------

function refName(ref: string, pointer: string): string {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`${pointer}: unsupported $ref target ${JSON.stringify(ref)}`);
  }
  return ref.slice(prefix.length);
}

/**
 * `.passthrough()` on every object, deliberately.
 *
 * These schemas sit on the boundary with a beta contract that Arcade extends
 * without asking us. Zod strips unknown keys by default, which would mean a
 * field Arcade adds is dropped between `parse()` and the audit log — data loss
 * that looks like nothing at all. Tolerating unknown keys is the documented
 * posture for a consumer of someone else's evolving payload.
 */
function expressionFor(schema: OpenApiSchema, pointer: string, indent: string): string {
  if (schema.$ref) return refName(schema.$ref, pointer);

  if (schema.enum) {
    if (schema.type !== "string") {
      throw new Error(`${pointer}: enum is only supported on type: string`);
    }
    return `z.enum([${schema.enum.map((v) => JSON.stringify(v)).join(", ")}])`;
  }

  switch (schema.type) {
    case "string":
      return "z.string()";
    case "boolean":
      return "z.boolean()";
    case "number":
    case "integer":
      return "z.number()";
    case "array": {
      if (!schema.items) throw new Error(`${pointer}: array without items`);
      return `z.array(${expressionFor(schema.items, `${pointer}/items`, indent)})`;
    }
    case "object":
      return objectExpression(schema, pointer, indent);
    case undefined:
      // A property with a description but no type — the spec's way of saying
      // "any JSON value" (`PostHookRequest.output`, `PostHookOverride.output`).
      return "z.unknown()";
    default:
      throw new Error(`${pointer}: unsupported type ${JSON.stringify(schema.type)}`);
  }
}

function objectExpression(
  schema: OpenApiSchema,
  pointer: string,
  indent: string,
): string {
  const properties = Object.entries(schema.properties ?? {});
  const additional = schema.additionalProperties;

  if (properties.length === 0) {
    // A free-form map: `additionalProperties: true` (or absent) means unknown
    // values, `additionalProperties: {schema}` constrains them.
    // Zod 4 takes the key schema explicitly; JSON object keys are always strings.
    if (additional === undefined || additional === true) {
      return "z.record(z.string(), z.unknown())";
    }
    if (additional === false) return "z.object({}).strict()";
    return `z.record(z.string(), ${expressionFor(additional, `${pointer}/additionalProperties`, indent)})`;
  }

  if (additional !== undefined) {
    throw new Error(
      `${pointer}: object with both properties and additionalProperties is not supported`,
    );
  }

  const required = new Set(schema.required ?? []);
  const body = `${indent}  `;
  const inner = `${body}  `;

  const lines = properties.map(([name, property]) => {
    const propertyPointer = `${pointer}/properties/${name}`;
    const expression = expressionFor(property, propertyPointer, inner);
    const optional = required.has(name) ? "" : ".optional()";
    const doc = property.description
      ? `${docComment(property.description, inner)}\n`
      : "";
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
    return `${doc}${inner}${key}: ${expression}${optional},`;
  });

  return [
    "z",
    `${body}.object({`,
    ...lines,
    `${body}})`,
    `${body}.passthrough()`,
  ].join("\n");
}

const DOC_WIDTH = 84;

/** Wraps `text` to fit `width` columns, preserving existing line breaks. */
function wrap(text: string, width: number): string[] {
  return text
    .trim()
    .split("\n")
    .flatMap((paragraph) => {
      const words = paragraph.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [""];
      const lines: string[] = [];
      let current = "";
      for (const word of words) {
        if (current === "") current = word;
        else if (`${current} ${word}`.length <= width) current = `${current} ${word}`;
        else {
          lines.push(current);
          current = word;
        }
      }
      lines.push(current);
      return lines;
    });
}

function docComment(description: string, indent: string): string {
  const lines = wrap(description, DOC_WIDTH - indent.length);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Dependency ordering
// ---------------------------------------------------------------------------

function referencedNames(schema: OpenApiSchema): string[] {
  const found: string[] = [];
  const walk = (node: OpenApiSchema | boolean | undefined): void => {
    if (!node || typeof node === "boolean") return;
    if (node.$ref) found.push(refName(node.$ref, "$ref"));
    for (const property of Object.values(node.properties ?? {})) walk(property);
    walk(node.items);
    walk(node.additionalProperties);
  };
  walk(schema);
  return found;
}

/**
 * Zod schemas are `const` declarations, so a schema must be emitted after
 * everything it references. Upstream's ordering happens to be close but is not
 * a guarantee — and a cycle would produce a TDZ crash at import time rather
 * than a compile error, so it is rejected here instead.
 */
function topologicallySorted(schemas: Record<string, OpenApiSchema>): string[] {
  const ordered: string[] = [];
  const settled = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string, trail: string[]): void => {
    if (settled.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`circular $ref: ${[...trail, name].join(" → ")}`);
    }
    const schema = schemas[name];
    if (!schema) throw new Error(`dangling $ref to ${name}`);
    visiting.add(name);
    for (const dependency of referencedNames(schema)) {
      visit(dependency, [...trail, name]);
    }
    visiting.delete(name);
    settled.add(name);
    ordered.push(name);
  };

  for (const name of Object.keys(schemas)) visit(name, []);
  return ordered;
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

function render(document: OpenApiDocument): string {
  const schemas = document.components.schemas;

  const declarations = topologicallySorted(schemas).map((name) => {
    const schema = schemas[name] as OpenApiSchema;
    const pointer = `#/components/schemas/${name}`;
    const doc = schema.description ? `${docComment(schema.description, "")}\n` : "";
    return [
      `${doc}export const ${name} = ${expressionFor(schema, pointer, "")};`,
      `export type ${name} = z.infer<typeof ${name}>;`,
    ].join("\n");
  });

  const endpoints = Object.entries(document.paths).flatMap(([path, methods]) =>
    Object.values(methods)
      .map((operation) => operation.operationId)
      .filter((id): id is string => typeof id === "string")
      .map((id) => `  ${id}: ${JSON.stringify(path)},`),
  );

  return `${header(document)}
import { z } from "zod";

/** Version of the upstream OpenAPI document these schemas were generated from. */
export const HOOK_CONTRACT_VERSION = ${JSON.stringify(document.info.version)};

/**
 * Default paths, by operation. Upstream is explicit that every path is
 * configurable per extension, so these are a starting point, not a contract —
 * whatever \`apps/hooks\` mounts must match what is registered in Arcade.
 */
export const HOOK_ENDPOINT_PATHS = {
${endpoints.join("\n")}
} as const;

${declarations.join("\n\n")}
`;
}

function header(document: OpenApiDocument): string {
  return `// ---------------------------------------------------------------------------
// GENERATED FILE — DO NOT EDIT.
//
// Source: ArcadeAI/schemas · logic_extensions/http/1.0/schema.yaml
//         vendored at packages/policy-schema/vendor/ (see vendor/README.md for
//         the pinned commit), spec version ${document.info.version}.
// Regenerate: bun run --cwd packages/policy-schema generate
//
// Every object is \`.passthrough()\`: this is a beta contract that Arcade extends
// without notice, and silently stripping a new field on the way into the audit
// log is worse than carrying one we do not understand.
// ---------------------------------------------------------------------------
`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function generate(specSource: string): string {
  return render(Bun.YAML.parse(specSource) as OpenApiDocument);
}

async function fetchUpstream(): Promise<void> {
  const response = await fetch(UPSTREAM_RAW);
  if (!response.ok) {
    throw new Error(`GET ${UPSTREAM_RAW} → ${response.status} ${response.statusText}`);
  }
  writeFileSync(SPEC_PATH, await response.text());
  console.log(`fetched ${UPSTREAM_RAW} → ${SPEC_PATH}`);
  console.log("now run `bun run generate`, and update the pin in vendor/README.md");
}

if (import.meta.main) {
  const mode = Bun.argv[2] ?? "--write";

  if (mode === "--fetch") {
    await fetchUpstream();
  } else {
    const generated = generate(readFileSync(SPEC_PATH, "utf8"));

    if (mode === "--check") {
      const committed = readFileSync(OUT_PATH, "utf8");
      if (committed !== generated) {
        console.error(
          `${OUT_PATH} is stale.\nRun: bun run --cwd packages/policy-schema generate`,
        );
        process.exit(1);
      }
      console.log(`${OUT_PATH} is up to date with ${SPEC_PATH}`);
    } else if (mode === "--write") {
      mkdirSync(dirname(OUT_PATH), { recursive: true });
      writeFileSync(OUT_PATH, generated);
      console.log(`wrote ${OUT_PATH}`);
    } else {
      console.error(`unknown mode ${JSON.stringify(mode)}; expected --write, --check or --fetch`);
      process.exit(2);
    }
  }
}
