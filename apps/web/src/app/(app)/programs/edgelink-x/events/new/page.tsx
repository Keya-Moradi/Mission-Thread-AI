import { prisma, PROGRAM_ID } from "@missionthread/core";
import { requireProgramManager } from "@/lib/auth-helpers";
import { EventEntryForm } from "./event-entry-form";

export default async function NewEventPage() {
  // Redirects away before rendering anything if the current session isn't
  // a Program Manager — see docs/DECISIONS.md, "Phase 3 mutation
  // authorization": this is a UX convenience, not the real security
  // boundary. recordProgramEvent() independently re-checks the actor's
  // current database role regardless of what this page allowed.
  await requireProgramManager();

  const [components, suppliers] = await Promise.all([
    prisma.component.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.supplier.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <>
      <h1 className="text-xl font-semibold text-foreground">Record a program event</h1>
      <p className="mt-1 text-sm text-muted">
        Supplier delays and general updates are recorded against EdgeLink-X and appear in the audit
        history immediately.
      </p>
      <div className="mt-6 max-w-xl rounded-lg border border-border bg-surface p-6">
        <EventEntryForm components={components} suppliers={suppliers} />
      </div>
    </>
  );
}
