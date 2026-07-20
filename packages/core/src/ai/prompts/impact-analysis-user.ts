import type { ModelInputProjection } from "../model-input";

/**
 * Serializes only the already-validated ModelInputProjection — no
 * interpolated prose wrapping individual untrusted fields, so there's no
 * surrounding sentence an injection attempt could try to hijack. The
 * untrustedData object is included as plain JSON data, under a key labeled
 * "untrustedData", exactly like every other field — its treatment as
 * non-instructional is established once, in the system prompt, not
 * re-asserted per field here. Never logged in full — see logging.ts.
 */
export function buildImpactAnalysisUserPrompt(modelInput: ModelInputProjection): string {
  return [
    "Analyze the following program event using only the data in this JSON object.",
    "Respond with exactly one JSON object matching the required output schema.",
    "",
    JSON.stringify(modelInput, null, 2),
  ].join("\n");
}
