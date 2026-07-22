import { describe, expect, it } from "vitest";
import {
  assertOpenAiCompatibleJsonSchema,
  buildOpenAiImpactAnalysisJsonSchema,
  OPENAI_DISALLOWED_JSON_SCHEMA_KEYWORDS,
} from "./openai-schema";
import { impactAnalysisOutputSchema } from "./output-schema";

/** Recursively collects every object key present anywhere in a JSON value. */
function collectAllKeys(node: unknown, keys: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectAllKeys(item, keys);
    return keys;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      keys.add(key);
      collectAllKeys(value, keys);
    }
  }
  return keys;
}

/** Finds every node in a JSON value whose `type` is "object", depth-first. */
function collectObjectSchemas(
  node: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) collectObjectSchemas(item, out);
    return out;
  }
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.type === "object" && obj.properties) out.push(obj);
    for (const value of Object.values(obj)) collectObjectSchemas(value, out);
  }
  return out;
}

describe("buildOpenAiImpactAnalysisJsonSchema — generated schema shape", () => {
  const schema = buildOpenAiImpactAnalysisJsonSchema();
  const allKeys = collectAllKeys(schema);

  it("[no prefixItems anywhere] a tuple-shaped mitigationOptions never appears", () => {
    expect(allKeys.has("prefixItems")).toBe(false);
  });

  it("[none of the disallowed keywords appear anywhere]", () => {
    for (const keyword of OPENAI_DISALLOWED_JSON_SCHEMA_KEYWORDS) {
      expect(allKeys.has(keyword)).toBe(false);
    }
  });

  it("[mitigationOptions uses items, not prefixItems]", () => {
    const props = (schema as { properties: Record<string, unknown> }).properties;
    const mitigationOptions = props.mitigationOptions as Record<string, unknown>;
    expect(mitigationOptions.items).toBeDefined();
    expect(mitigationOptions).not.toHaveProperty("prefixItems");
  });

  it("[minItems === 3]", () => {
    const props = (schema as { properties: Record<string, unknown> }).properties;
    const mitigationOptions = props.mitigationOptions as Record<string, unknown>;
    expect(mitigationOptions.minItems).toBe(3);
  });

  it("[maxItems === 3]", () => {
    const props = (schema as { properties: Record<string, unknown> }).properties;
    const mitigationOptions = props.mitigationOptions as Record<string, unknown>;
    expect(mitigationOptions.maxItems).toBe(3);
  });

  it("[every object schema declares additionalProperties: false]", () => {
    const objectSchemas = collectObjectSchemas(schema);
    expect(objectSchemas.length).toBeGreaterThan(0);
    for (const objectSchema of objectSchemas) {
      expect(objectSchema.additionalProperties).toBe(false);
    }
  });

  it("[every object property is listed in required]", () => {
    const objectSchemas = collectObjectSchemas(schema);
    for (const objectSchema of objectSchemas) {
      const propertyNames = Object.keys(objectSchema.properties as Record<string, unknown>);
      const required = objectSchema.required as unknown[];
      for (const name of propertyNames) {
        expect(required).toContain(name);
      }
    }
  });

  it("does not throw when verified — self-consistency of the builder's own check", () => {
    expect(() => assertOpenAiCompatibleJsonSchema(schema)).not.toThrow();
  });
});

describe("assertOpenAiCompatibleJsonSchema — rejects disallowed shapes", () => {
  it.each(OPENAI_DISALLOWED_JSON_SCHEMA_KEYWORDS)('rejects a schema containing "%s"', (keyword) => {
    const badSchema = {
      type: "object",
      properties: {},
      additionalProperties: false,
      required: [],
      [keyword]: [],
    };
    expect(() => assertOpenAiCompatibleJsonSchema(badSchema)).toThrow();
  });

  it("rejects an object schema missing additionalProperties: false", () => {
    const badSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    expect(() => assertOpenAiCompatibleJsonSchema(badSchema)).toThrow();
  });

  it("rejects an object schema with a property missing from required", () => {
    const badSchema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(() => assertOpenAiCompatibleJsonSchema(badSchema)).toThrow();
  });

  it("accepts a fully-compliant nested schema", () => {
    const goodSchema = {
      type: "object",
      properties: {
        a: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
      },
      required: ["a"],
      additionalProperties: false,
    };
    expect(() => assertOpenAiCompatibleJsonSchema(goodSchema)).not.toThrow();
  });
});

describe("impactAnalysisOutputSchema — exactly-three-option enforcement is unchanged after the tuple->array fix", () => {
  function validOption(overrides: Record<string, unknown> = {}) {
    return {
      title: "Option",
      description: "Description.",
      tradeoffs: "Tradeoffs.",
      costImpact: null,
      scheduleImpact: null,
      isRecommended: false,
      sourceRecordIds: ["EVT-001"],
      ...overrides,
    };
  }
  function validOutput(mitigationOptions: unknown[]) {
    return {
      executiveSummary: "Summary.",
      missionImpact: "Impact.",
      scheduleExposureDays: 1,
      budgetExposureAmount: "1.00",
      affectedRequirementIds: [],
      affectedMilestoneIds: [],
      verificationGaps: [],
      assumptions: [],
      unknowns: [],
      confidence: "MEDIUM",
      sourceRecordIds: ["EVT-001"],
      mitigationOptions,
    };
  }

  it("[two options] fails", () => {
    expect(
      impactAnalysisOutputSchema.safeParse(
        validOutput([validOption({ isRecommended: true }), validOption()]),
      ).success,
    ).toBe(false);
  });

  it("[four options] fails", () => {
    expect(
      impactAnalysisOutputSchema.safeParse(
        validOutput([
          validOption({ isRecommended: true }),
          validOption(),
          validOption(),
          validOption(),
        ]),
      ).success,
    ).toBe(false);
  });

  it("[exactly three options, one recommended] passes", () => {
    expect(
      impactAnalysisOutputSchema.safeParse(
        validOutput([validOption({ isRecommended: true }), validOption(), validOption()]),
      ).success,
    ).toBe(true);
  });

  it("[zero recommended] fails", () => {
    expect(
      impactAnalysisOutputSchema.safeParse(
        validOutput([validOption(), validOption(), validOption()]),
      ).success,
    ).toBe(false);
  });

  it("[multiple recommended] fails", () => {
    expect(
      impactAnalysisOutputSchema.safeParse(
        validOutput([
          validOption({ isRecommended: true }),
          validOption({ isRecommended: true }),
          validOption(),
        ]),
      ).success,
    ).toBe(false);
  });
});
