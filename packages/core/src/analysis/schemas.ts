import { z } from "zod";

// See docs/DECISIONS.md, "Input-ID validation: reject padding/whitespace/
// duplicates, never silently normalize". Real seeded IDs never carry
// surrounding whitespace, so a padded or whitespace-only ID is treated as a
// caller bug to surface, not a value to silently clean up and accept.
export const entityIdSchema = z
  .string()
  .min(1, "ID must not be empty")
  .refine((value) => value.trim().length > 0, "ID must not be whitespace-only")
  .refine((value) => value === value.trim(), "ID must not have leading or trailing whitespace");

// Empty arrays are allowed (an empty, non-malformed request); duplicate IDs
// are rejected outright rather than deduplicated, since a duplicate would
// double-count that record in coverage ratios and gap lists — see
// docs/DECISIONS.md.
export const entityIdArraySchema = z
  .array(entityIdSchema)
  .refine((ids) => new Set(ids).size === ids.length, "duplicate IDs are not allowed");

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}
