import { prisma, PROGRAM_ID } from "@missionthread/core";
import { requireSession } from "@/lib/auth-helpers";
import { Nav } from "@/components/nav";

async function getProgramSummary() {
  const [program, requirementCount, milestoneCount, openRiskCount, eventCount] = await Promise.all([
    prisma.program.findUnique({ where: { id: PROGRAM_ID } }),
    prisma.requirement.count({ where: { programId: PROGRAM_ID } }),
    prisma.milestone.count({ where: { programId: PROGRAM_ID } }),
    prisma.risk.count({ where: { programId: PROGRAM_ID, status: "OPEN" } }),
    prisma.programEvent.count({ where: { programId: PROGRAM_ID } }),
  ]);

  return { program, requirementCount, milestoneCount, openRiskCount, eventCount };
}

const STAT_CARDS = [
  { key: "requirementCount", label: "Requirements" },
  { key: "milestoneCount", label: "Milestones" },
  { key: "openRiskCount", label: "Open risks" },
  { key: "eventCount", label: "Recorded events" },
] as const;

export default async function DashboardPage() {
  const session = await requireSession();
  const summary = await getProgramSummary();

  return (
    <div className="flex min-h-screen flex-col">
      <Nav user={{ name: session.user.name, role: session.user.role }} />

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">Executive Dashboard</h1>
          <p className="text-sm text-muted">
            {summary.program?.name ?? "EdgeLink-X"} — {summary.program?.description}
          </p>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {STAT_CARDS.map((card) => (
            <div key={card.key} className="rounded-lg border border-border bg-surface p-4">
              <div className="text-2xl font-semibold text-foreground">{summary[card.key]}</div>
              <div className="mt-1 text-sm text-muted">{card.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-8 rounded-lg border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground">Protected workflow spine</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Event → deterministic analysis → bounded AI interpretation → three mitigation options →
            approval → apply preview → audit. Phase 1 establishes the workspace, schema, seed data,
            and authentication that this workflow will run on. The supplier-delay workflow itself is
            built starting in Phase 2.
          </p>
        </div>
      </main>
    </div>
  );
}
