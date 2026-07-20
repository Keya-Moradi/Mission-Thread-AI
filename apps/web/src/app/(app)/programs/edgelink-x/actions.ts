"use server";

import { redirect } from "next/navigation";
import { runImpactAnalysis } from "@missionthread/core";
import { auth } from "@/auth";

/**
 * Program-Manager-only analysis trigger for a recorded event. The actor ID
 * comes only from the authenticated session, never from form data;
 * authorization is independently re-checked by runImpactAnalysis() itself
 * (packages/core/src/ai/orchestrator.ts) against the actor's current
 * database role, exactly like recordProgramEvent() — this action does not
 * duplicate that check, only relies on it. Always redirects into the
 * analysis workspace on success (whether the run itself SUCCEEDED or
 * FAILED — a failed attempt still has a real analysisRunId/traceId to show);
 * a request-level error (bad session, unknown event, non-manager role)
 * redirects back to the overview with a safe, already-generic error message.
 */
export async function analyzeEventAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(
      `/programs/edgelink-x?analysisError=${encodeURIComponent("Your session has expired. Please sign in again.")}`,
    );
  }

  const eventId = formData.get("eventId");
  if (typeof eventId !== "string" || eventId.length === 0) {
    redirect(`/programs/edgelink-x?analysisError=${encodeURIComponent("Missing event ID.")}`);
  }

  const result = await runImpactAnalysis(eventId, session.user.id);

  if (!result.ok) {
    redirect(`/programs/edgelink-x?analysisError=${encodeURIComponent(result.error.message)}`);
  }

  redirect(`/programs/edgelink-x/analyses/${encodeURIComponent(result.data.analysisRunId)}`);
}
