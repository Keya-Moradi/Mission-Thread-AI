"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { eventEntrySchema, recordProgramEvent } from "@missionthread/core";
import { auth } from "@/auth";
import { buildEventEntryInputFromFormData } from "./form-input";

export interface EventFormState {
  error: string | null;
  fieldErrors: Record<string, string>;
}

function toFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
  }
  return fieldErrors;
}

export async function recordEventAction(
  _prevState: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // The actor comes only from the authenticated session, never from
  // formData — this form has no actor/program input at all, and
  // recordProgramEvent() independently re-verifies this ID's current role
  // from the database regardless.
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Your session has expired. Please sign in again.", fieldErrors: {} };
  }

  const rawInput = buildEventEntryInputFromFormData(formData);

  // Validated locally first so field-level errors can be shown next to
  // the specific input that caused them; recordProgramEvent() validates
  // the same contract again internally regardless, as the actual
  // authoritative check — this is redundant defense-in-depth, not a
  // second source of truth for what's valid.
  const parsed = eventEntrySchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      error: "Please fix the highlighted fields.",
      fieldErrors: toFieldErrors(parsed.error),
    };
  }

  const result = await recordProgramEvent(rawInput, session.user.id);

  if (!result.ok) {
    if (result.error.code === "VALIDATION_ERROR") {
      return { error: "Please fix the highlighted fields.", fieldErrors: {} };
    }
    // FORBIDDEN and NOT_FOUND messages are already safe, generic text —
    // see docs/DECISIONS.md, "Phase 3 mutation authorization" — safe to
    // show directly.
    return { error: result.error.message, fieldErrors: {} };
  }

  redirect(`/programs/edgelink-x?eventRecorded=${encodeURIComponent(result.data.eventId)}`);
}
