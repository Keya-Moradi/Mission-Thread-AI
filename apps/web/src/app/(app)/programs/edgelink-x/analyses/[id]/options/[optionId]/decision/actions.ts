"use server";

import { redirect } from "next/navigation";
import { recordMitigationDecision } from "@missionthread/core";
import { auth } from "@/auth";

export interface DecisionFormState {
  error: string | null;
}

/**
 * Bound with (analysisRunId, optionId) by the client form so it matches
 * useActionState's (prevState, formData) signature. The actor ID comes only
 * from the authenticated session, never from form data; verdict/role
 * permission enforcement happens entirely inside recordMitigationDecision()
 * (packages/core) — this action does not duplicate that check.
 * `proposedChangesJson` is a structured-editor-produced payload (see
 * decision-form.tsx), never a free-form textarea the user types JSON into —
 * recordMitigationDecision() validates its exact shape regardless of how it
 * arrived here.
 */
export async function submitDecisionAction(
  analysisRunId: string,
  optionId: string,
  _prevState: DecisionFormState,
  formData: FormData,
): Promise<DecisionFormState> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Your session has expired. Please sign in again." };
  }

  const verdict = formData.get("verdict");
  const rationale = formData.get("rationale");
  if (typeof verdict !== "string" || typeof rationale !== "string") {
    return { error: "Please fix the highlighted fields." };
  }

  let input: unknown;
  if (verdict === "APPROVED") {
    const proposedChangesRaw = formData.get("proposedChangesJson");
    let proposedChanges: unknown;
    try {
      proposedChanges =
        typeof proposedChangesRaw === "string" ? JSON.parse(proposedChangesRaw) : [];
    } catch {
      return { error: "Proposed changes were malformed. Please try again." };
    }
    input = { verdict: "APPROVED", mitigationOptionId: optionId, rationale, proposedChanges };
  } else {
    input = { verdict, mitigationOptionId: optionId, rationale };
  }

  const result = await recordMitigationDecision(input, session.user.id);
  if (!result.ok) {
    return { error: result.error.message };
  }

  if (result.data.verdict === "APPROVED") {
    redirect(
      `/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}/options/${encodeURIComponent(optionId)}/apply`,
    );
  }

  redirect(`/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}?decisionRecorded=1`);
}
