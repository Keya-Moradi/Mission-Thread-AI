import { z } from "zod";
import { entityIdSchema } from "../analysis/schemas";

// Documented, reasonable bounds — not exact values the spec dictates, but
// chosen deliberately and applied consistently so oversized/absurd input
// (a fat-fingered extra digit, a pasted document instead of a note) is
// rejected at the boundary rather than silently accepted. Independent of
// EVIDENCE_LIMITS.maxUntrustedTextLength (packages/core/src/analysis/
// evidence.ts) even though the rawNotes number happens to match it — that
// limit governs evidence *truncation* for a future model input, this one
// governs what a caller is allowed to *submit* in the first place.
export const MAX_REASON_LENGTH = 500;
export const MAX_RAW_NOTES_LENGTH = 4000;
/** Arbitrary but documented upper bound — large enough for any real lot
 * size this fictional program would plausibly report, small enough to
 * catch an obviously-wrong input (e.g. an extra trailing zero). */
export const MAX_QUANTITY = 100_000;

const DATE_FORMAT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict YYYY-MM-DD input that must also be a real calendar date — e.g.
 * "2026-02-30" matches the format regex but is rejected here, because
 * `Date.UTC(2026, 1, 30)` normalizes to March 2 and the round-trip check
 * below catches the mismatch. UTC throughout, matching
 * packages/core/src/analysis/schedule.ts's own date-arithmetic assumption
 * that every date this schema stores is UTC-midnight-aligned.
 */
function isValidCalendarDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export const dateOnlySchema = z
  .string()
  .regex(DATE_FORMAT_PATTERN, "must be in YYYY-MM-DD format")
  .refine(isValidCalendarDateString, "must be a valid calendar date");

export const confidenceSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

const supplierDelayEventObjectSchema = z
  .object({
    eventType: z.literal("SUPPLIER_DELAY"),
    componentId: entityIdSchema,
    supplierId: entityIdSchema,
    originalDate: dateOnlySchema,
    revisedDate: dateOnlySchema,
    confidence: confidenceSchema,
    quantity: z.number().int().positive().max(MAX_QUANTITY),
    reason: z.string().trim().min(1).max(MAX_REASON_LENGTH).optional(),
    rawNotes: z.string().trim().min(1).max(MAX_RAW_NOTES_LENGTH).optional(),
  })
  .strict();

const generalUpdateEventObjectSchema = z
  .object({
    eventType: z.literal("GENERAL_UPDATE"),
    componentId: entityIdSchema.optional(),
    supplierId: entityIdSchema.optional(),
    rawNotes: z.string().trim().min(1, "rawNotes is required").max(MAX_RAW_NOTES_LENGTH),
  })
  .strict();

export const supplierDelayEventSchema = supplierDelayEventObjectSchema;
export const generalUpdateEventSchema = generalUpdateEventObjectSchema;

/**
 * The full event-entry contract: a strict discriminated union keyed by
 * `eventType`, plus one cross-field rule (revisedDate must be later than
 * originalDate) applied via `superRefine` rather than a per-branch
 * `.refine()` — Zod's `discriminatedUnion` needs each member to stay a
 * plain object it can introspect for the discriminator key, which a
 * `.refine()`-wrapped branch (a ZodEffects, not a ZodObject) breaks.
 * `delayDays` is deliberately not a field here at all: it's never
 * accepted from a caller, only computed server-side in
 * recordProgramEvent() — see docs/DECISIONS.md.
 */
export const eventEntrySchema = z
  .discriminatedUnion("eventType", [supplierDelayEventObjectSchema, generalUpdateEventObjectSchema])
  .superRefine((data, ctx) => {
    if (data.eventType === "SUPPLIER_DELAY") {
      // Plain string comparison is valid here specifically because both
      // operands are already-validated YYYY-MM-DD strings — zero-padded
      // ISO date strings sort lexicographically in the same order as
      // chronological order, so no Date parsing is needed for this check.
      if (data.revisedDate <= data.originalDate) {
        ctx.addIssue({
          code: "custom",
          message: "revisedDate must be later than originalDate",
          path: ["revisedDate"],
        });
      }
    }
  });

export type SupplierDelayEventInput = z.infer<typeof supplierDelayEventObjectSchema>;
export type GeneralUpdateEventInput = z.infer<typeof generalUpdateEventObjectSchema>;
export type EventEntryInput = z.infer<typeof eventEntrySchema>;

export function formatEventEntryZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}
