"use client";

import { useActionState, useState } from "react";
import { submitApplyAction, type ApplyFormState } from "./actions";

// Defined here, not in actions.ts: a "use server" file may only export
// async functions — a plain object export like this would break module
// evaluation entirely ("A 'use server' file can only export async
// functions, found object") — see docs/DECISIONS.md and the identical
// pattern in events/new/event-entry-form.tsx.
const initialApplyFormState: ApplyFormState = { error: null };

export function ApplyConfirmForm({
  analysisRunId,
  optionId,
  disabled,
  confirmationValue,
}: {
  analysisRunId: string;
  optionId: string;
  disabled: boolean;
  // Passed down from the server page component (packages/core's
  // APPLY_CONFIRMATION_VALUE) rather than imported directly here — this is
  // a "use client" component, and importing from the @missionthread/core
  // barrel would pull in packages/core/src/db.ts's Prisma/pg dependency
  // graph into the browser bundle.
  confirmationValue: string;
}) {
  const boundAction = submitApplyAction.bind(null, analysisRunId, optionId);
  const [state, formAction, isPending] = useActionState(boundAction, initialApplyFormState);
  const [confirmation, setConfirmation] = useState("");

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">
          Type <span className="font-mono">{confirmationValue}</span> to confirm
        </span>
        <input
          type="text"
          name="confirmation"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          className="w-40 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:border-accent disabled:opacity-60"
        />
      </label>

      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {state.error}
        </p>
      )}

      <div>
        <button
          type="submit"
          disabled={disabled || isPending || confirmation !== confirmationValue}
          className="rounded-md bg-danger px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {isPending ? "Applying…" : "Apply changes"}
        </button>
      </div>
    </form>
  );
}
