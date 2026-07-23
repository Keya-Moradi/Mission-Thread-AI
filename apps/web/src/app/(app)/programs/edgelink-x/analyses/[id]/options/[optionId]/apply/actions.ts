"use server";

import { redirect } from "next/navigation";
import { applyApprovedChanges } from "@missionthread/core";
import { auth } from "@/auth";

export interface ApplyFormState {
  error: string | null;
}

/**
 * Bound with (analysisRunId, optionId) by the client form. The actor ID
 * comes only from the session; role/state/confirmation enforcement all
 * happens inside applyApprovedChanges() (packages/core) — this action does
 * not duplicate any of it. `confirmation` must be the exact literal
 * "APPLY", read directly from the submitted form field, never a hidden
 * Boolean.
 */
export async function submitApplyAction(
  analysisRunId: string,
  optionId: string,
  _prevState: ApplyFormState,
  formData: FormData,
): Promise<ApplyFormState> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "Your session has expired. Please sign in again." };
  }

  const confirmation = formData.get("confirmation");
  if (typeof confirmation !== "string") {
    return { error: "Please type APPLY to confirm." };
  }

  const result = await applyApprovedChanges(optionId, session.user.id, confirmation);
  if (!result.ok) {
    return { error: result.error.message };
  }

  redirect(
    `/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}/options/${encodeURIComponent(optionId)}/apply?applied=1`,
  );
}
