"use client";

import { useFormStatus } from "react-dom";
import { analyzeEventAction } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="shrink-0 rounded-md border border-accent px-2 py-1 text-xs font-medium text-accent transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Analyzing…" : "Analyze"}
    </button>
  );
}

// Program-Manager-only control (rendered only when the caller passes it in
// a manager session — see the program overview page). This is a UX
// convenience, not the real security boundary: analyzeEventAction() ->
// runImpactAnalysis() independently re-verifies the actor's current
// database role regardless of whether this button was ever rendered.
export function AnalyzeButton({ eventId }: { eventId: string }) {
  return (
    <form action={analyzeEventAction}>
      <input type="hidden" name="eventId" value={eventId} />
      <SubmitButton />
    </form>
  );
}
