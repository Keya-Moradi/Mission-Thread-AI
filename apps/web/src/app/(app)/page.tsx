import Link from "next/link";
import {
  prisma,
  PROGRAM_ID,
  Role,
  calculateReadinessScore,
  calculateBudgetVariance,
  calculateScheduleExposure,
  getVerificationGaps,
} from "@missionthread/core";
import { requireSession } from "@/lib/auth-helpers";
import { StatCard } from "@/components/stat-card";

const RECENT_EVENTS_LIMIT = 5;

async function loadDashboardData() {
  const [
    requirementIds,
    milestoneCounts,
    openRiskCount,
    openDefectCount,
    recentEvents,
    latestSupplierDelay,
    readinessResult,
    budgetResult,
  ] = await Promise.all([
    prisma.requirement.findMany({ where: { programId: PROGRAM_ID }, select: { id: true } }),
    prisma.milestone.groupBy({
      by: ["status"],
      where: { programId: PROGRAM_ID },
      _count: { _all: true },
    }),
    prisma.risk.count({ where: { programId: PROGRAM_ID, status: "OPEN" } }),
    prisma.defect.count({
      where: { programId: PROGRAM_ID, status: { in: ["OPEN", "IN_PROGRESS"] } },
    }),
    prisma.programEvent.findMany({
      where: { programId: PROGRAM_ID },
      orderBy: { createdAt: "desc" },
      take: RECENT_EVENTS_LIMIT,
      select: {
        id: true,
        eventType: true,
        createdAt: true,
        component: { select: { name: true } },
        supplier: { select: { name: true } },
        delayDays: true,
      },
    }),
    prisma.programEvent.findFirst({
      where: { programId: PROGRAM_ID, eventType: "SUPPLIER_DELAY" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    calculateReadinessScore(PROGRAM_ID),
    calculateBudgetVariance(PROGRAM_ID),
  ]);

  const milestoneCount = milestoneCounts.reduce((sum, group) => sum + group._count._all, 0);
  const atRiskOrDelayedCount = milestoneCounts
    .filter((group) => group.status === "AT_RISK" || group.status === "DELAYED")
    .reduce((sum, group) => sum + group._count._all, 0);

  const verificationGapsResult =
    requirementIds.length > 0 ? await getVerificationGaps(requirementIds.map((r) => r.id)) : null;
  const verificationGapCount = verificationGapsResult?.ok
    ? verificationGapsResult.data.results.filter((r) => r.gapCategory !== "NONE").length
    : null;

  const scheduleExposureResult = latestSupplierDelay
    ? await calculateScheduleExposure(latestSupplierDelay.id)
    : null;

  return {
    requirementCount: requirementIds.length,
    verificationGapCount,
    milestoneCount,
    atRiskOrDelayedCount,
    openRiskCount,
    openDefectCount,
    recentEvents,
    scheduleExposureResult,
    readinessResult,
    budgetResult,
  };
}

function formatCurrency(amount: string | null, currency: string | null): string {
  if (amount === null) return "—";
  const numeric = Number(amount);
  return `${currency ?? "USD"} ${numeric.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function DashboardPage() {
  const [session, program, data] = await Promise.all([
    requireSession(),
    prisma.program.findUnique({ where: { id: PROGRAM_ID } }),
    loadDashboardData(),
  ]);

  const isProgramManager = session.user.role === Role.PROGRAM_MANAGER;
  const { readinessResult, budgetResult, scheduleExposureResult } = data;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">Executive Dashboard</h1>
          <p className="text-sm text-muted">
            {program?.name ?? "EdgeLink-X"} — {program?.description}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href="/programs/edgelink-x"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-background"
          >
            Program overview
          </Link>
          {isProgramManager && (
            <Link
              href="/programs/edgelink-x/events/new"
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
            >
              Record event
            </Link>
          )}
        </div>
      </div>

      {/* Readiness score */}
      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">Program readiness</h2>
          {readinessResult.ok && (
            <span className="text-3xl font-semibold text-foreground" data-testid="readiness-score">
              {readinessResult.data.totalScore}
              <span className="text-base font-normal text-muted">/100</span>
            </span>
          )}
        </div>
        {readinessResult.ok ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-5">
            {readinessResult.data.factors.map((factor) => (
              <div key={factor.label} className="rounded-md bg-background p-3">
                <div className="text-lg font-semibold text-foreground">
                  {factor.score.toFixed(1)}/20
                </div>
                <div className="mt-0.5 text-xs text-muted">{factor.label}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-sm text-danger">
            Readiness score is unavailable: {readinessResult.error.message}
          </p>
        )}
        {readinessResult.ok && readinessResult.data.warnings.length > 0 && (
          <ul className="mt-3 list-inside list-disc text-xs text-muted">
            {readinessResult.data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Key metrics */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard testId="requirementCount" label="Requirements" value={data.requirementCount} />
        <StatCard
          testId="verificationGapCount"
          label="Verification gaps"
          value={data.verificationGapCount ?? 0}
          unavailable={data.verificationGapCount === null}
        />
        <StatCard testId="milestoneCount" label="Milestones" value={data.milestoneCount} />
        <StatCard
          testId="atRiskMilestoneCount"
          label="At-risk / delayed milestones"
          value={data.atRiskOrDelayedCount}
        />
        <StatCard testId="openRiskCount" label="Open risks" value={data.openRiskCount} />
        <StatCard
          testId="openDefectCount"
          label="Open / in-progress defects"
          value={data.openDefectCount}
        />
      </div>

      {/* Budget */}
      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-foreground">Budget</h2>
        {budgetResult.ok ? (
          budgetResult.data.plannedTotal !== null ? (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-lg font-semibold text-foreground">
                  {formatCurrency(budgetResult.data.plannedTotal, budgetResult.data.currency)}
                </div>
                <div className="text-xs text-muted">Planned</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">
                  {formatCurrency(budgetResult.data.actualTotal, budgetResult.data.currency)}
                </div>
                <div className="text-xs text-muted">Actual</div>
              </div>
              <div>
                <div
                  className={`text-lg font-semibold ${Number(budgetResult.data.varianceAmount) > 0 ? "text-danger" : "text-success"}`}
                >
                  {formatCurrency(budgetResult.data.varianceAmount, budgetResult.data.currency)}
                </div>
                <div className="text-xs text-muted">Variance (actual − planned)</div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">
              {budgetResult.data.missingData[0] ??
                "Budget totals are unavailable for this program."}
            </p>
          )
        ) : (
          <p className="mt-2 text-sm text-danger">
            Budget variance is unavailable: {budgetResult.error.message}
          </p>
        )}
      </section>

      {/* Latest supplier-delay schedule exposure */}
      {scheduleExposureResult && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground">
            Latest supplier-delay schedule exposure
          </h2>
          {scheduleExposureResult.ok ? (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <div className="text-lg font-semibold text-foreground">
                  {scheduleExposureResult.data.directDelayDays ?? "—"}
                </div>
                <div className="text-xs text-muted">Direct delay (days)</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">
                  {scheduleExposureResult.data.impactedMilestoneIds.length}
                </div>
                <div className="text-xs text-muted">Impacted milestones</div>
              </div>
              <div>
                <div className="text-lg font-semibold text-foreground">
                  {scheduleExposureResult.data.latestExposedDate ?? "—"}
                </div>
                <div className="text-xs text-muted">Latest exposed date</div>
              </div>
            </div>
          ) : (
            <p className="mt-2 text-sm text-danger">
              Schedule exposure is unavailable: {scheduleExposureResult.error.message}
            </p>
          )}
        </section>
      )}

      {/* Recent events */}
      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-foreground">Recent program events</h2>
        {data.recentEvents.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No events have been recorded yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {data.recentEvents.map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div>
                  <span className="font-medium text-foreground">
                    {event.eventType.replaceAll("_", " ")}
                  </span>
                  {event.component && <span className="text-muted"> — {event.component.name}</span>}
                  {event.supplier && <span className="text-muted"> ({event.supplier.name})</span>}
                  {event.delayDays !== null && (
                    <span className="text-muted"> · {event.delayDays}-day delay</span>
                  )}
                </div>
                <time
                  className="shrink-0 text-xs text-muted"
                  dateTime={event.createdAt.toISOString()}
                >
                  {event.createdAt.toISOString().slice(0, 10)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
