import Link from "next/link";
import { notFound } from "next/navigation";
import {
  prisma,
  PROGRAM_ID,
  Role,
  checkProposedChangeStale,
  APPLY_CONFIRMATION_VALUE,
} from "@missionthread/core";
import { requireSession } from "@/lib/auth-helpers";
import { StatusBadge } from "@/components/status-badge";
import { ApplyConfirmForm } from "./apply-confirm-form";

async function loadOption(optionId: string) {
  return prisma.mitigationOption.findUnique({
    where: { id: optionId },
    include: {
      impactAnalysis: { select: { id: true, analysisRunId: true } },
      decision: { include: { actor: { select: { name: true, email: true } } } },
      proposedChanges: { orderBy: { id: "asc" } },
    },
  });
}

function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => `${key}: ${String(v)}`)
      .join(", ");
  }
  return String(value);
}

export default async function ApplyPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; optionId: string }>;
  searchParams: Promise<{ applied?: string }>;
}) {
  const session = await requireSession();
  const { id: analysisRunId, optionId } = await params;
  const resolvedSearchParams = await searchParams;

  const option = await loadOption(optionId);
  if (!option || option.impactAnalysis.analysisRunId !== analysisRunId) {
    notFound();
  }

  if (!option.decision || option.decision.verdict !== "APPROVED" || option.status !== "APPROVED") {
    return (
      <>
        <h1 className="text-xl font-semibold text-foreground">Apply preview unavailable</h1>
        <p className="mt-3 text-sm text-muted">
          This mitigation option has not been approved, so there is nothing to apply.
        </p>
        <p className="mt-4">
          <Link
            href={`/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}/options/${encodeURIComponent(optionId)}/decision`}
            className="text-sm text-accent hover:underline"
          >
            Go to the decision page
          </Link>
        </p>
      </>
    );
  }

  const pendingChanges = option.proposedChanges.filter((change) => change.status === "PENDING");
  const appliedChanges = option.proposedChanges.filter((change) => change.status === "APPLIED");

  // Read-only staleness check for the preview — reuses the identical
  // comparison applyApprovedChanges() runs inside its own transaction at
  // apply time. Never mutates anything while rendering.
  const staleChecks = await Promise.all(
    pendingChanges.map(async (change) => ({
      changeId: change.id,
      result: await checkProposedChangeStale(prisma, change, PROGRAM_ID),
    })),
  );
  const staleByChangeId = new Map(staleChecks.map((c) => [c.changeId, c.result]));
  const anyStale = staleChecks.some((c) => c.result.stale);

  const isProgramManager = session.user.role === Role.PROGRAM_MANAGER;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Apply preview</h1>
          <p className="mt-1 font-mono text-xs text-muted">{option.id}</p>
        </div>
        <StatusBadge status={option.status} />
      </div>

      {resolvedSearchParams.applied && (
        <p
          role="status"
          className="mt-4 rounded-md border border-success/30 bg-success/10 px-4 py-3 text-sm text-success"
        >
          Changes applied successfully.
        </p>
      )}

      {pendingChanges.length > 0 && (
        <p
          role="status"
          className="mt-4 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          Nothing has been applied yet. Review every proposed change below, then confirm to apply
          them all in one transaction.
        </p>
      )}

      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-foreground">Decision</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs tracking-wide text-muted uppercase">Decided by</dt>
            <dd className="mt-0.5 text-foreground">{option.decision.actor.name}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-muted uppercase">Trace ID</dt>
            <dd className="mt-0.5 font-mono text-xs text-foreground">{option.decision.traceId}</dd>
          </div>
        </dl>
        <div className="mt-3">
          <dt className="text-xs tracking-wide text-muted uppercase">Rationale</dt>
          <dd className="mt-1 text-sm text-foreground">{option.decision.rationale}</dd>
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-foreground">Proposed changes</h2>
        {pendingChanges.length === 0 && appliedChanges.length > 0 && (
          <p className="mt-3 text-sm text-muted">
            Every proposed change for this option has already been applied.
          </p>
        )}
        <div className="mt-3 flex flex-col gap-3">
          {[...pendingChanges, ...appliedChanges].map((change) => {
            const stale = staleByChangeId.get(change.id);
            return (
              <div
                key={change.id}
                className="rounded-md border border-border bg-background p-3 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {change.changeType.replaceAll("_", " ")}
                  </span>
                  <div className="flex items-center gap-2">
                    {stale?.stale && <StatusBadge status="CONFLICT" />}
                    <StatusBadge status={change.status} />
                  </div>
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-2 text-xs text-muted sm:grid-cols-3">
                  <div>
                    <dt className="uppercase">Target</dt>
                    <dd className="mt-0.5 font-mono text-foreground">
                      {change.targetRecordId ?? "(new action)"}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase">Captured old value</dt>
                    <dd className="mt-0.5 text-foreground">{formatJsonValue(change.oldValue)}</dd>
                  </div>
                  <div>
                    <dt className="uppercase">Proposed new value</dt>
                    <dd className="mt-0.5 text-foreground">{formatJsonValue(change.newValue)}</dd>
                  </div>
                </dl>
                {stale?.stale && (
                  <p className="mt-2 text-xs text-danger">
                    Warning: the underlying record has changed since this decision was approved.
                    Applying is blocked until a new decision is recorded.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {pendingChanges.length > 0 && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground">Apply</h2>
          {isProgramManager ? (
            <>
              {anyStale && (
                <p className="mt-2 text-sm text-danger">
                  At least one proposed change is stale. Applying is disabled until a new decision
                  replaces this one.
                </p>
              )}
              <div className="mt-3">
                <ApplyConfirmForm
                  analysisRunId={analysisRunId}
                  optionId={optionId}
                  disabled={anyStale}
                  confirmationValue={APPLY_CONFIRMATION_VALUE}
                />
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">
              Only a Program Manager may apply approved changes.
            </p>
          )}
        </section>
      )}

      <p className="mt-6">
        <Link
          href={`/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}`}
          className="text-sm text-muted hover:text-foreground"
        >
          ← Back to analysis workspace
        </Link>
      </p>
    </>
  );
}
