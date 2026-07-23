import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma, EVIDENCE_RECORD_TYPES } from "@missionthread/core";
import { requireSession } from "@/lib/auth-helpers";
import { StatusBadge } from "@/components/status-badge";

interface VerificationGapJson {
  requirementId: string;
  category: string;
  summary: string;
}

interface ReadinessSnapshotJson {
  totalScore: number;
  factors: Array<{ label: string; score: number; detail: string }>;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asReadinessSnapshot(value: unknown): ReadinessSnapshotJson | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("totalScore" in value) ||
    !("factors" in value) ||
    !Array.isArray((value as { factors: unknown }).factors)
  ) {
    return null;
  }
  return value as ReadinessSnapshotJson;
}

function asVerificationGaps(value: unknown): VerificationGapJson[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is VerificationGapJson =>
      typeof item === "object" &&
      item !== null &&
      "requirementId" in item &&
      "category" in item &&
      "summary" in item,
  );
}

function formatMoney(amount: unknown): string {
  return `USD ${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function loadAnalysisRun(analysisRunId: string) {
  const analyses = await prisma.impactAnalysis.findMany({
    where: { analysisRunId },
    orderBy: { attempt: "asc" },
    include: {
      mitigationOptions: {
        orderBy: { optionIndex: "asc" },
        include: {
          decision: { include: { actor: { select: { name: true } } } },
          proposedChanges: { select: { id: true } },
        },
      },
      sourceReferences: { orderBy: [{ recordType: "asc" }, { recordId: "asc" }] },
      programEvent: { include: { component: true, supplier: true } },
      requestedBy: { select: { name: true, email: true } },
    },
  });
  return analyses;
}

export default async function AnalysisWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Every authenticated role may view a completed analysis — only the
  // Analyze control on the program overview page is Program-Manager-only.
  await requireSession();
  const { id: analysisRunId } = await params;

  const analyses = await loadAnalysisRun(analysisRunId);
  if (analyses.length === 0) {
    notFound();
  }

  const succeeded = analyses.find((a) => a.status === "SUCCEEDED");
  const latest = analyses[analyses.length - 1]!;
  const overallStatus = succeeded ? "SUCCEEDED" : latest.status;
  const event = latest.programEvent;

  const evidenceByType = new Map<string, (typeof analyses)[number]["sourceReferences"]>();
  if (succeeded) {
    for (const type of EVIDENCE_RECORD_TYPES) {
      const items = succeeded.sourceReferences.filter((ref) => ref.recordType === type);
      if (items.length > 0) evidenceByType.set(type, items);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Impact analysis</h1>
          <p className="mt-1 font-mono text-xs text-muted">Run {analysisRunId}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={overallStatus} />
          {succeeded && (
            <Link
              href={`/programs/edgelink-x/briefings/${encodeURIComponent(analysisRunId)}`}
              className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
            >
              View readiness briefing
            </Link>
          )}
        </div>
      </div>

      <Section title="Triggering event">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Field label="Event">
            <span className="font-mono text-xs">{event.id}</span>
          </Field>
          <Field label="Type">{event.eventType.replaceAll("_", " ")}</Field>
          <Field label="Component">{event.component?.name ?? "—"}</Field>
          <Field label="Supplier">{event.supplier?.name ?? "—"}</Field>
          <Field label="Requested by">{latest.requestedBy.name}</Field>
        </dl>
      </Section>

      <Section title="Attempts">
        <div className="mt-3 flex flex-col gap-3">
          {analyses.map((analysis) => (
            <div
              key={analysis.id}
              className="rounded-md border border-border bg-background p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-foreground">Attempt {analysis.attempt}</span>
                <StatusBadge status={analysis.status} />
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted sm:grid-cols-4">
                <Field label="Trace ID" mono>
                  {analysis.traceId}
                </Field>
                <Field label="Mode">{analysis.aiMode}</Field>
                <Field label="Provider">{analysis.provider ?? "—"}</Field>
                <Field label="Model">{analysis.model ?? "—"}</Field>
                <Field label="Duration">
                  {analysis.durationMs !== null ? `${analysis.durationMs} ms` : "—"}
                </Field>
                {analysis.status === "FAILED" && (
                  <Field label="Failure category">{analysis.errorCategory ?? "unknown"}</Field>
                )}
              </dl>
              {analysis.status === "FAILED" && Array.isArray(analysis.validationErrors) && (
                <ul className="mt-2 list-disc pl-5 text-xs text-danger">
                  {asStringArray(analysis.validationErrors).map((issue, index) => (
                    <li key={index}>{issue}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </Section>

      {!succeeded && (
        <Section title="Result">
          <p className="mt-3 text-sm text-muted">
            {overallStatus === "PENDING"
              ? "This analysis is still in progress."
              : "Every attempt for this run failed validation or the provider call. No mitigation options were generated — see the failure category and trace ID above for the safe diagnostic detail available."}
          </p>
        </Section>
      )}

      {succeeded && (
        <>
          <Section title="Executive summary">
            <p className="mt-3 text-sm text-foreground">{succeeded.executiveSummary}</p>
            <p className="mt-3 text-sm text-foreground">{succeeded.missionImpact}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
              <Field label="Confidence">
                <StatusBadge status={succeeded.confidence ?? "MEDIUM"} />
              </Field>
              <Field label="Schedule exposure">
                {succeeded.scheduleExposureDays !== null
                  ? `${succeeded.scheduleExposureDays} day(s)`
                  : "Unknown"}
              </Field>
              <Field label="Budget exposure">
                {succeeded.budgetExposureAmount !== null
                  ? formatMoney(succeeded.budgetExposureAmount)
                  : "Unknown"}
              </Field>
            </dl>
          </Section>

          <Section title="Program readiness at analysis time">
            <p className="mt-2 text-xs text-muted">
              A snapshot of program readiness captured when this analysis ran — never recalculated,
              so this attempt&apos;s record stays accurate even after later program changes.
            </p>
            {(() => {
              const readiness = asReadinessSnapshot(succeeded.readinessSnapshot);
              if (!readiness)
                return <EmptyState message="Readiness was unavailable when this analysis ran." />;
              return (
                <>
                  <p className="mt-3 text-lg font-semibold text-foreground">
                    {readiness.totalScore}/100
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-xs text-muted sm:grid-cols-5">
                    {readiness.factors.map((factor) => (
                      <Field key={factor.label} label={factor.label}>
                        {factor.score.toFixed(1)}/20
                      </Field>
                    ))}
                  </dl>
                </>
              );
            })()}
          </Section>

          <Section title="Verification gaps">
            {asVerificationGaps(succeeded.verificationGaps).length === 0 ? (
              <EmptyState message="No verification gaps identified." />
            ) : (
              <ul className="mt-3 flex flex-col gap-2 text-sm">
                {asVerificationGaps(succeeded.verificationGaps).map((gap, index) => (
                  <li key={index} className="rounded-md border border-border bg-background p-2">
                    <span className="font-mono text-xs text-muted">{gap.requirementId}</span>{" "}
                    <StatusBadge status={gap.category} /> <span>{gap.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Assumptions and unknowns">
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Assumptions
                </h3>
                <ul className="mt-2 list-disc pl-5 text-sm text-foreground">
                  {asStringArray(succeeded.assumptions).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  Unknowns
                </h3>
                <ul className="mt-2 list-disc pl-5 text-sm text-foreground">
                  {asStringArray(succeeded.unknowns).map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </Section>

          <Section title="Mitigation options">
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {succeeded.mitigationOptions.map((option) => (
                <div
                  key={option.id}
                  data-testid="mitigation-option"
                  className={`rounded-lg border p-4 text-sm ${
                    option.isRecommended
                      ? "border-accent bg-accent/5"
                      : "border-border bg-background"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-medium text-foreground">{option.title}</h3>
                    <div className="flex items-center gap-2">
                      {option.isRecommended && (
                        <span
                          data-testid="mitigation-recommended-badge"
                          className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
                        >
                          Recommended
                        </span>
                      )}
                      <StatusBadge status={option.status} />
                    </div>
                  </div>
                  <p className="mt-2 text-foreground">{option.description}</p>
                  <p className="mt-2 text-xs text-muted">Tradeoffs: {option.tradeoffs}</p>
                  <dl className="mt-2 flex gap-4 text-xs text-muted">
                    <span>
                      Cost:{" "}
                      {option.costImpact !== null
                        ? formatMoney(option.costImpact)
                        : "Not estimated"}
                    </span>
                    <span>
                      Schedule:{" "}
                      {option.scheduleImpact !== null
                        ? `${option.scheduleImpact} day(s)`
                        : "Not estimated"}
                    </span>
                  </dl>

                  {option.decision ? (
                    <div className="mt-3 rounded-md border border-border bg-surface p-2 text-xs text-muted">
                      <p>
                        Decided by{" "}
                        <span className="text-foreground">{option.decision.actor.name}</span> on{" "}
                        {option.decision.createdAt.toISOString().slice(0, 10)} ·{" "}
                        {option.proposedChanges.length} proposed change(s)
                      </p>
                      <Link
                        href={`/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}/options/${encodeURIComponent(option.id)}/decision`}
                        className="mt-1 inline-block text-accent hover:underline"
                      >
                        View decision
                      </Link>
                      {option.status === "APPROVED" && (
                        <>
                          {" · "}
                          <Link
                            href={`/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}/options/${encodeURIComponent(option.id)}/apply`}
                            className="text-accent hover:underline"
                          >
                            Apply preview
                          </Link>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="mt-3 text-xs text-muted italic">
                      Awaiting human review — this is not an approval or applied change.{" "}
                      <Link
                        href={`/programs/edgelink-x/analyses/${encodeURIComponent(analysisRunId)}/options/${encodeURIComponent(option.id)}/decision`}
                        className="text-accent not-italic hover:underline"
                      >
                        Record a decision
                      </Link>
                    </p>
                  )}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Evidence supplied to analysis">
            <p className="mt-2 text-xs text-muted">
              Every record supplied to this attempt&apos;s model input. Not every supplied record
              was necessarily cited by the model — &ldquo;Cited&rdquo; marks the ones the output
              actually referenced, and where.
            </p>
            <div className="mt-3 flex flex-col gap-3">
              {[...evidenceByType.entries()].map(([type, items]) => (
                <div key={type}>
                  <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                    {type.replaceAll("_", " ")}
                  </h3>
                  <ul className="mt-1 flex flex-col gap-1 text-sm">
                    {items.map((item) => (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-center gap-2 text-foreground"
                      >
                        <span className="font-mono text-xs text-muted">{item.recordId}</span>
                        <span>{item.summary}</span>
                        {item.wasCited ? (
                          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                            Cited ({asStringArray(item.citationContexts).join(", ")})
                          </span>
                        ) : (
                          <span className="rounded-full bg-border px-2 py-0.5 text-xs font-medium text-muted">
                            Supplied only
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
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

function Field({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs tracking-wide text-muted uppercase">{label}</dt>
      <dd className={`mt-0.5 text-foreground ${mono ? "font-mono text-xs" : ""}`}>{children}</dd>
    </div>
  );
}
