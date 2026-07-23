import Link from "next/link";
import { notFound } from "next/navigation";
import {
  prisma,
  PROGRAM_ID,
  Role,
  RATIONALE_MIN_LENGTH,
  RATIONALE_MAX_LENGTH,
} from "@missionthread/core";
import { requireSession } from "@/lib/auth-helpers";
import { StatusBadge } from "@/components/status-badge";
import { DecisionForm } from "./decision-form";

async function loadOption(optionId: string) {
  return prisma.mitigationOption.findUnique({
    where: { id: optionId },
    include: {
      impactAnalysis: { select: { id: true, analysisRunId: true, status: true } },
      decision: { include: { actor: { select: { name: true, email: true } } } },
      proposedChanges: { select: { id: true } },
    },
  });
}

async function loadTargetOptions() {
  const [milestones, risks, budgetItems] = await Promise.all([
    prisma.milestone.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    }),
    prisma.risk.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, title: true },
      orderBy: { id: "asc" },
    }),
    prisma.budgetItem.findMany({
      where: { programId: PROGRAM_ID },
      select: { id: true, category: true, description: true },
      orderBy: { id: "asc" },
    }),
  ]);
  return {
    milestones: milestones.map((m) => ({ id: m.id, label: m.name })),
    risks: risks.map((r) => ({ id: r.id, label: r.title })),
    budgetItems: budgetItems.map((b) => ({ id: b.id, label: `${b.category} — ${b.description}` })),
  };
}

export default async function MitigationOptionDecisionPage({
  params,
}: {
  params: Promise<{ id: string; optionId: string }>;
}) {
  const session = await requireSession();
  const { id: analysisRunId, optionId } = await params;

  const option = await loadOption(optionId);
  if (!option || option.impactAnalysis.analysisRunId !== analysisRunId) {
    notFound();
  }

  const role = session.user.role;
  const canApproveOrReject = role === Role.PROGRAM_MANAGER;
  const canRequestRevision = role === Role.PROGRAM_MANAGER || role === Role.ENGINEERING_LEAD;
  const isPending = option.status === "PENDING";

  const targetOptions = isPending && canApproveOrReject ? await loadTargetOptions() : null;

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Mitigation option decision</h1>
          <p className="mt-1 font-mono text-xs text-muted">{option.id}</p>
        </div>
        <StatusBadge status={option.status} />
      </div>

      <section className="mt-6 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-foreground">{option.title}</h2>
        <p className="mt-2 text-sm text-foreground">{option.description}</p>
        <p className="mt-2 text-xs text-muted">Tradeoffs: {option.tradeoffs}</p>
        {option.isRecommended && (
          <span className="mt-3 inline-flex rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
            Recommended
          </span>
        )}
      </section>

      {option.decision && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground">Decision on record</h2>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs tracking-wide text-muted uppercase">Verdict</dt>
              <dd className="mt-0.5">
                <StatusBadge status={option.decision.verdict} />
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-muted uppercase">Decided by</dt>
              <dd className="mt-0.5 text-foreground">{option.decision.actor.name}</dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-muted uppercase">Decided at</dt>
              <dd className="mt-0.5 text-foreground">
                {option.decision.createdAt.toISOString().slice(0, 16).replace("T", " ")}
              </dd>
            </div>
            <div>
              <dt className="text-xs tracking-wide text-muted uppercase">Proposed changes</dt>
              <dd className="mt-0.5 text-foreground">{option.proposedChanges.length}</dd>
            </div>
          </dl>
          <div className="mt-3">
            <dt className="text-xs tracking-wide text-muted uppercase">Rationale</dt>
            <dd className="mt-1 text-sm text-foreground">{option.decision.rationale}</dd>
          </div>
          {option.status === "APPROVED" && (
            <Link
              href={`/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}/options/${encodeURIComponent(optionId)}/apply`}
              className="mt-4 inline-block rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
            >
              View apply preview
            </Link>
          )}
        </section>
      )}

      {!option.decision && !canApproveOrReject && !canRequestRevision && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-6">
          <p className="text-sm text-muted">
            You have read-only access to this mitigation option. No decision has been recorded yet.
          </p>
        </section>
      )}

      {!option.decision && isPending && (canApproveOrReject || canRequestRevision) && (
        <section className="mt-6 rounded-lg border border-border bg-surface p-6">
          <h2 className="text-sm font-semibold text-foreground">Record a decision</h2>
          <p className="mt-1 text-xs text-muted">
            {canApproveOrReject
              ? "As Program Manager you may approve, reject, or request revision."
              : "As Engineering Lead you may request revision. Only a Program Manager may approve or reject."}
          </p>
          <div className="mt-4">
            <DecisionForm
              analysisRunId={analysisRunId}
              optionId={optionId}
              canApproveOrReject={canApproveOrReject}
              targetOptions={targetOptions}
              rationaleMinLength={RATIONALE_MIN_LENGTH}
              rationaleMaxLength={RATIONALE_MAX_LENGTH}
            />
          </div>
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
