import { z } from "zod";
import { impactAnalysisOutputSchema } from "./output-schema";

/**
 * JSON Schema keywords that draft-2020-12 permits but OpenAI's Structured
 * Outputs strict mode does not document support for. `z.toJSONSchema()` is a
 * general-purpose draft-2020-12 generator — it has no notion of "OpenAI's
 * supported subset" — so its output must be verified against this list
 * before being sent to the Responses API, rather than trusted blindly. See
 * docs/DECISIONS.md, "Phase 4 correction: provider-facing JSON Schema
 * subset".
 */
export const OPENAI_DISALLOWED_JSON_SCHEMA_KEYWORDS = [
  "prefixItems",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "propertyNames",
  "patternProperties",
] as const;

/**
 * Recursively verifies a JSON Schema node against OpenAI's strict-mode
 * requirements: none of the disallowed keywords above appear anywhere, and
 * every object schema declares `additionalProperties: false` with every one
 * of its `properties` listed in `required` (OpenAI strict mode has no
 * concept of an optional property — nullable fields express optionality
 * instead, which is exactly how output-schema.ts is written). Throws with a
 * precise path on the first violation rather than silently patching the
 * schema — a schema this function had to "fix" would mean
 * impactAnalysisOutputSchema itself no longer matches what's actually sent
 * to the provider, which is a correctness bug worth failing loudly on, not
 * papering over.
 */
export function assertOpenAiCompatibleJsonSchema(node: unknown, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertOpenAiCompatibleJsonSchema(item, `${path}[${index}]`));
    return;
  }
  if (node === null || typeof node !== "object") {
    return;
  }

  const obj = node as Record<string, unknown>;

  for (const keyword of OPENAI_DISALLOWED_JSON_SCHEMA_KEYWORDS) {
    if (keyword in obj) {
      throw new Error(
        `Generated JSON Schema uses "${keyword}" at ${path}, which is outside OpenAI Structured Outputs' documented supported subset.`,
      );
    }
  }

  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    if (obj.additionalProperties !== false) {
      throw new Error(`Object schema at ${path} must declare "additionalProperties: false".`);
    }
    const propertyNames = Object.keys(obj.properties as Record<string, unknown>);
    const required = Array.isArray(obj.required) ? obj.required : [];
    for (const name of propertyNames) {
      if (!required.includes(name)) {
        throw new Error(`Object schema at ${path} must list property "${name}" in "required".`);
      }
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    assertOpenAiCompatibleJsonSchema(value, `${path}.${key}`);
  }
}

/**
 * Generates the JSON Schema sent to the Responses API's `text.format`
 * strict-mode structured output — always derived FROM
 * `impactAnalysisOutputSchema` (never a second, hand-maintained schema),
 * and always verified against OpenAI's supported subset before use. This is
 * steering for the provider, not the sole enforcement: every parsed
 * response is still re-validated against the authoritative Zod schema
 * (see openai-provider.ts / orchestrator.ts).
 */
export function buildOpenAiImpactAnalysisJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(impactAnalysisOutputSchema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  assertOpenAiCompatibleJsonSchema(schema);
  return schema;
}
