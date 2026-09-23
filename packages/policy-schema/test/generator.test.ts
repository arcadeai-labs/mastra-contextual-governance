/**
 * The generator's own coverage.
 *
 * A generator is only trustworthy if it fails loudly on input it does not
 * understand. The alternative failure — quietly emitting `z.unknown()` for a
 * construct it cannot handle — produces a validator that accepts everything,
 * which reads as a passing test suite right up until a malformed hook response
 * takes out every tool in the project.
 *
 * So: one case per OpenAPI construct the vendored document uses, and one per
 * construct it does not, asserting the generator throws rather than guesses.
 */
import { describe, expect, it } from "bun:test";

import { generate } from "../scripts/generate-hook-contract.ts";

/** Wraps `schemas` in the minimum document the generator will accept. */
function documentWith(schemas: Record<string, unknown>): string {
  return Bun.YAML.stringify({
    openapi: "3.0.3",
    info: { title: "test", version: "0.0.0-test" },
    paths: {},
    components: { schemas },
  });
}

function generateSchemas(schemas: Record<string, unknown>): string {
  return generate(documentWith(schemas));
}

describe("type mapping", () => {
  const cases: ReadonlyArray<readonly [label: string, schema: unknown, expected: string]> = [
    ["string", { type: "string" }, "z.string()"],
    ["boolean", { type: "boolean" }, "z.boolean()"],
    ["number", { type: "number" }, "z.number()"],
    ["integer", { type: "integer" }, "z.number()"],
    ["string enum", { type: "string", enum: ["a", "b"] }, 'z.enum(["a", "b"])'],
    ["array", { type: "array", items: { type: "string" } }, "z.array(z.string())"],
    [
      "free-form object",
      { type: "object", additionalProperties: true },
      "z.record(z.string(), z.unknown())",
    ],
    [
      "map with a typed value",
      { type: "object", additionalProperties: { type: "string" } },
      "z.record(z.string(), z.string())",
    ],
    [
      "array of maps",
      {
        type: "array",
        items: { type: "object", additionalProperties: { type: "string" } },
      },
      "z.array(z.record(z.string(), z.string()))",
    ],
  ];

  for (const [label, schema, expected] of cases) {
    it(`maps a ${label}`, () => {
      expect(generateSchemas({ Target: schema })).toContain(
        `export const Target = ${expected};`,
      );
    });
  }

  it("maps a typeless property to z.unknown(), the spec's 'any JSON value'", () => {
    // `PostHookRequest.output` is written exactly this way upstream.
    const emitted = generateSchemas({
      Target: { type: "object", properties: { output: { description: "any" } } },
    });
    expect(emitted).toContain("output: z.unknown().optional()");
  });
});

describe("objects", () => {
  const target = {
    type: "object",
    required: ["needed"],
    properties: { needed: { type: "string" }, spare: { type: "string" } },
  };

  it("marks properties outside `required` as optional", () => {
    const emitted = generateSchemas({ Target: target });
    expect(emitted).toContain("needed: z.string(),");
    expect(emitted).toContain("spare: z.string().optional(),");
  });

  it("passes unknown keys through rather than stripping them", () => {
    // Arcade extends this contract without notice. Zod 3 strips by default,
    // which would silently drop a new field on the way to the audit log.
    expect(generateSchemas({ Target: target })).toContain(".passthrough()");
  });

  it("quotes a property name that is not a valid identifier", () => {
    const emitted = generateSchemas({
      Target: { type: "object", properties: { "not-an-identifier": { type: "string" } } },
    });
    expect(emitted).toContain('"not-an-identifier": z.string().optional(),');
  });

  it("emits a doc comment from a description", () => {
    const emitted = generateSchemas({
      Target: { type: "object", description: "What it is", properties: {} },
    });
    expect(emitted).toContain("/** What it is */");
  });
});

describe("references", () => {
  it("emits a referenced schema before the schema that uses it", () => {
    // Zod schemas are `const`s, so the wrong order is a TDZ crash at import
    // time — not something the typechecker would catch first.
    const emitted = generateSchemas({
      Uses: { type: "object", properties: { it: { $ref: "#/components/schemas/Used" } } },
      Used: { type: "string" },
    });
    expect(emitted.indexOf("export const Used")).toBeLessThan(
      emitted.indexOf("export const Uses"),
    );
  });

  it("follows a reference through an array and a map", () => {
    const emitted = generateSchemas({
      ViaArray: { type: "array", items: { $ref: "#/components/schemas/Leaf" } },
      ViaMap: { type: "object", additionalProperties: { $ref: "#/components/schemas/Leaf" } },
      Leaf: { type: "string" },
    });
    expect(emitted).toContain("export const ViaArray = z.array(Leaf);");
    expect(emitted).toContain("export const ViaMap = z.record(z.string(), Leaf);");
    expect(emitted.indexOf("export const Leaf")).toBeLessThan(
      emitted.indexOf("export const ViaArray"),
    );
  });

  it("rejects a cycle instead of emitting a schema that crashes on import", () => {
    expect(() =>
      generateSchemas({
        A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
        B: { type: "object", properties: { a: { $ref: "#/components/schemas/A" } } },
      }),
    ).toThrow(/circular \$ref/);
  });

  it("rejects a dangling reference", () => {
    expect(() =>
      generateSchemas({
        A: { type: "object", properties: { b: { $ref: "#/components/schemas/Missing" } } },
      }),
    ).toThrow(/dangling \$ref to Missing/);
  });

  it("rejects a reference outside components/schemas", () => {
    expect(() =>
      generateSchemas({ A: { $ref: "./other.yaml#/Thing" } }),
    ).toThrow(/unsupported \$ref target/);
  });
});

describe("unsupported input fails loudly", () => {
  it("rejects an unknown type", () => {
    expect(() => generateSchemas({ A: { type: "null" } })).toThrow(/unsupported type/);
  });

  it("rejects an array without items", () => {
    expect(() => generateSchemas({ A: { type: "array" } })).toThrow(/array without items/);
  });

  it("rejects a non-string enum", () => {
    expect(() => generateSchemas({ A: { type: "integer", enum: [1, 2] } })).toThrow(
      /enum is only supported on type: string/,
    );
  });

  it("rejects an object mixing properties and additionalProperties", () => {
    expect(() =>
      generateSchemas({
        A: {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: { type: "string" },
        },
      }),
    ).toThrow(/both properties and additionalProperties/);
  });

  it("names the offending schema in the error", () => {
    expect(() =>
      generateSchemas({
        Fine: { type: "string" },
        Broken: { type: "object", properties: { bad: { type: "null" } } },
      }),
    ).toThrow(/#\/components\/schemas\/Broken\/properties\/bad/);
  });
});

describe("the whole document", () => {
  it("carries the upstream spec version and the default endpoint paths", () => {
    const emitted = generate(
      Bun.YAML.stringify({
        openapi: "3.0.3",
        info: { title: "test", version: "9.9.9-test" },
        paths: { "/somewhere": { post: { operationId: "preHook" } } },
        components: { schemas: {} },
      }),
    );
    expect(emitted).toContain('export const HOOK_CONTRACT_VERSION = "9.9.9-test";');
    expect(emitted).toContain('preHook: "/somewhere",');
  });
});
