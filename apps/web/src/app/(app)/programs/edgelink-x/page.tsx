import Link from "next/link";
import { prisma, PROGRAM_ID, Role, getVerificationGaps } from "@missionthread/core";
import { requireSession } from "@/lib/auth-helpers";
import { StatusBadge } from "@/components/status-badge";
import { AnalyzeButton } from "./analyze-button";

async function loadProgramOverviewData() {
  const [
    program,
    components,
    requirements,
    milestones,
    dependencies,
    risks,
    testCases,
    defects,
    budgetItems,
    suppliers,
    recentEvents,
  ] = await Promise.all([
    prisma.program.findUnique({ where: { id: PROGRAM_ID } }),
    prisma.component.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, name: true, subsystem: true, description: true },
      orderBy: { id: "asc" },
    }),
    prisma.requirement.findMany({
      where: { programId: PROGRAM_ID },
      select: {
        id: true,
        title: true,
        priority: true,
        status: true,
        components: { select: { component: { select: { id: true, name: true } } } },
      },
      orderBy: { id: "asc" },
    }),
    prisma.milestone.findMany({
      where: { programId: PROGRAM_ID },
      select: {
        id: true,
        name: true,
        status: true,
        plannedDate: true,
        currentDate: true,
        componentId: true,
      },
      orderBy: { id: "asc" },
    }),
    prisma.dependency.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, fromMilestoneId: true, toMilestoneId: true },
      orderBy: { id: "asc" },
    }),
    prisma.risk.findMany({
      where: { programId: PROGRAM_ID },
      select: {
        id: true,
        title: true,
        severity: true,
        status: true,
        probability: true,
        impact: true,
        componentId: true,
      },
      orderBy: { id: "asc" },
    }),
    prisma.testCase.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, name: true, outcome: true, lastRunAt: true },
      orderBy: { id: "asc" },
    }),
    prisma.defect.findMany({
      where: { programId: PROGRAM_ID, status: { not: "CLOSED" } },
      select: { id: true, title: true, severity: true, status: true },
      orderBy: { id: "asc" },
    }),
    prisma.budgetItem.findMany({
      where: { programId: PROGRAM_ID },
      select: {
        id: true,
        category: true,
        description: true,
        plannedAmount: true,
        actualAmount: true,
        currency: true,
        componentId: true,
      },
      orderBy: { id: "asc" },
    }),
    // Contact info is deliberately excluded — not needed for this
    // overview and not something to expose beyond what's necessary.
    prisma.supplier.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    }),
    prisma.programEvent.findMany({
      where: { programId: PROGRAM_ID },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        eventType: true,
        createdAt: true,
        delayDays: true,
        rawNotes: true,
        component: { select: { name: true } },
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const requirementIds = requirements.map((r) => r.id);
  const gapsResult = requirementIds.length > 0 ? await getVerificationGaps(requirementIds) : null;
  const gapByRequirementId = new Map(
    gapsResult?.ok ? gapsResult.data.results.map((r) => [r.requirementId, r.gapCategory]) : [],
  );

  const milestoneNameById = new Map(milestones.map((m) => [m.id, m.name]));
  const componentNameById = new Map(components.map((c) => [c.id, c.name]));

  return {
    program,
    components,
    requirements,
    milestones,
    dependencies,
    risks,
    testCases,
    defects,
    budgetItems,
    suppliers,
    recentEvents,
    gapByRequirementId,
    milestoneNameById,
    componentNameById,
  };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatMoney(amount: unknown, currency: string): string {
  return `${currency} ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function ProgramOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ eventRecorded?: string; analysisError?: string }>;
}) {
  const [session, data, resolvedSearchParams] = await Promise.all([
    requireSession(),
    loadProgramOverviewData(),
    searchParams,
  ]);
  const isProgramManager = session.user.role === Role.PROGRAM_MANAGER;

  const plannedTotal = data.budgetItems.reduce((sum, item) => sum + Number(item.plannedAmount), 0);
  const actualTotal = data.budgetItems.reduce((sum, item) => sum + Number(item.actualAmount), 0);

  return (
    <>
      {resolvedSearchParams.eventRecorded && (
        <div
          role="status"
          className="mb-4 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        >
          Event <span className="font-mono">{resolvedSearchParams.eventRecorded}</span> recorded
          successfully.
        </div>
      )}

      {resolvedSearchParams.analysisError && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
        >
          {resolvedSearchParams.analysisError}
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">
            {data.program?.name ?? "EdgeLink-X"} Program Overview
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">{data.program?.description}</p>
        </div>
        {isProgramManager && (
          <Link
            href="/programs/edgelink-x/events/new"
            className="shrink-0 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
          >
            Record event
          </Link>
        )}
      </div>

      {/* Components */}
      <Section title="Components and subsystems">
        <Table
          columns={["Component", "Subsystem"]}
          rows={data.components.map((c) => [
            <span key="name" className="font-medium text-foreground">
              {c.name}
            </span>,
            c.subsystem,
          ])}
        />
      </Section>

      {/* Requirements */}
      <Section title="Requirements and component traceability">
        <Table
          columns={["ID", "Title", "Priority", "Status", "Components", "Verification"]}
          rows={data.requirements.map((r) => [
            <span key="id" className="font-mono text-xs text-muted">
              {r.id}
            </span>,
            r.title,
            r.priority,
            <StatusBadge key="status" status={r.status} />,
            r.components.map((c) => c.component.name).join(", ") || "—",
            <StatusBadge key="gap" status={data.gapByRequirementId.get(r.id) ?? "NO_COVERAGE"} />,
          ])}
        />
      </Section>

      {/* Milestones */}
      <Section title="Milestones">
        <Table
          columns={["Milestone", "Component", "Planned", "Current", "Status"]}
          rows={data.milestones.map((m) => [
            m.name,
            m.componentId ? (data.componentNameById.get(m.componentId) ?? "—") : "—",
            formatDate(m.plannedDate),
            formatDate(m.currentDate),
            <StatusBadge key="status" status={m.status} />,
          ])}
        />
      </Section>

      {/* Dependencies */}
      <Section title="Dependency relationships">
        {data.dependencies.length === 0 ? (
          <EmptyState message="No dependency edges recorded." />
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5 text-sm">
            {data.dependencies.map((dep) => (
              <li key={dep.id} className="flex items-center gap-2 text-foreground">
                <span>
                  {data.milestoneNameById.get(dep.fromMilestoneId) ?? dep.fromMilestoneId}
                </span>
                <span aria-hidden className="text-muted">
                  →
                </span>
                <span>{data.milestoneNameById.get(dep.toMilestoneId) ?? dep.toMilestoneId}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Risk register */}
      <Section title="Risk register">
        <Table
          columns={["Risk", "Component", "Probability", "Impact", "Severity", "Status"]}
          rows={data.risks.map((r) => [
            r.title,
            r.componentId ? (data.componentNameById.get(r.componentId) ?? "—") : "—",
            String(r.probability),
            String(r.impact),
            <StatusBadge key="severity" status={r.severity} />,
            <StatusBadge key="status" status={r.status} />,
          ])}
        />
      </Section>

      {/* Test outcomes */}
      <Section title="Test outcomes and verification coverage">
        <Table
          columns={["Test", "Outcome", "Last run"]}
          rows={data.testCases.map((t) => [
            t.name,
            <StatusBadge key="outcome" status={t.outcome} />,
            t.lastRunAt ? formatDate(t.lastRunAt) : "Never run",
          ])}
        />
      </Section>

      {/* Open defects */}
      <Section title="Open defects">
        {data.defects.length === 0 ? (
          <EmptyState message="No open defects." />
        ) : (
          <Table
            columns={["Defect", "Severity", "Status"]}
            rows={data.defects.map((d) => [
              d.title,
              <StatusBadge key="severity" status={d.severity} />,
              <StatusBadge key="status" status={d.status} />,
            ])}
          />
        )}
      </Section>

      {/* Budget */}
      <Section title="Budget items and variance">
        <Table
          columns={["Category", "Component", "Planned", "Actual", "Variance"]}
          rows={data.budgetItems.map((b) => {
            const variance = Number(b.actualAmount) - Number(b.plannedAmount);
            return [
              b.category,
              b.componentId ? (data.componentNameById.get(b.componentId) ?? "—") : "—",
              formatMoney(b.plannedAmount, b.currency),
              formatMoney(b.actualAmount, b.currency),
              <span
                key="variance"
                className={
                  variance > 0 ? "text-danger" : variance < 0 ? "text-success" : "text-muted"
                }
              >
                {variance > 0 ? "+" : ""}
                {formatMoney(variance, b.currency)}
              </span>,
            ];
          })}
        />
        <p className="mt-3 text-sm text-muted">
          Program total: planned {formatMoney(plannedTotal, "USD")}, actual{" "}
          {formatMoney(actualTotal, "USD")}
        </p>
      </Section>

      {/* Suppliers */}
      <Section title="Suppliers">
        <ul className="mt-3 flex flex-wrap gap-2">
          {data.suppliers.map((s) => (
            <li
              key={s.id}
              className="rounded-full border border-border bg-background px-3 py-1 text-sm text-foreground"
            >
              {s.name}
            </li>
          ))}
        </ul>
      </Section>

      {/* Recent events */}
      <Section title="Recent events">
        {data.recentEvents.length === 0 ? (
          <EmptyState message="No events recorded yet." />
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {data.recentEvents.map((event) => (
              <li
                key={event.id}
                className="rounded-md border border-border bg-background p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {event.eventType.replaceAll("_", " ")}
                  </span>
                  <div className="flex items-center gap-3">
                    <time className="text-xs text-muted" dateTime={event.createdAt.toISOString()}>
                      {formatDate(event.createdAt)}
                    </time>
                    {isProgramManager && <AnalyzeButton eventId={event.id} />}
                  </div>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {event.component && <>Component: {event.component.name} </>}
                  {event.supplier && <>· Supplier: {event.supplier.name} </>}
                  {event.delayDays !== null && <>· Delay: {event.delayDays} days</>}
                </div>
                {event.rawNotes && (
                  <div className="mt-2 rounded border border-border bg-surface p-2">
                    <div className="text-xs font-medium tracking-wide text-muted uppercase">
                      Submitted note (untrusted, unverified content)
                    </div>
                    <p className="mt-1 text-xs whitespace-pre-wrap text-foreground">
                      {event.rawNotes}
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-border bg-surface p-6">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function EmptyState({ message }: { message: string }) {
  return <p className="mt-3 text-sm text-muted">{message}</p>;
}

function Table({ columns, rows }: { columns: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) {
    return <EmptyState message="No records found." />;
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs tracking-wide text-muted uppercase">
            {columns.map((column) => (
              <th key={column} className="py-2 pr-4 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, rowIndex) => (
            // Rows have no stable ID at this generic-table level; callers control ordering.
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="py-2 pr-4 align-top text-foreground">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
