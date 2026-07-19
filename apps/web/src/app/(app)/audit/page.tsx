import Link from "next/link";
import { z } from "zod";
import { prisma, AUDIT_ACTIONS, AUDIT_ACTOR_TYPES, AUDIT_TARGET_TYPES } from "@missionthread/core";
import { StatusBadge } from "@/components/status-badge";

// Bounded result set — see docs/DECISIONS.md, "Audit filtering and result
// limit". Not a pagination mechanism (Phase 3 doesn't need one for this
// data volume); just a hard ceiling so this page can never accidentally
// render an unbounded table.
const RESULT_LIMIT = 50;

const traceIdFilterSchema = z.string().trim().min(1).max(100);

interface AuditSearchParams {
  action?: string;
  actorType?: string;
  targetType?: string;
  traceId?: string;
}

/**
 * Invalid or unrecognized filter values (a stale bookmark, a hand-edited
 * URL) are silently ignored — treated as "no filter" for that dimension —
 * rather than erroring the whole page. This is a read-only filtering UI,
 * not a form submission; failing open to "show unfiltered" is safer and
 * friendlier than a broken page for what's ultimately a bookmarkable GET
 * request.
 */
function parseFilters(searchParams: AuditSearchParams) {
  const action = AUDIT_ACTIONS.includes(searchParams.action as (typeof AUDIT_ACTIONS)[number])
    ? (searchParams.action as (typeof AUDIT_ACTIONS)[number])
    : undefined;
  const actorType = AUDIT_ACTOR_TYPES.includes(
    searchParams.actorType as (typeof AUDIT_ACTOR_TYPES)[number],
  )
    ? (searchParams.actorType as (typeof AUDIT_ACTOR_TYPES)[number])
    : undefined;
  const targetType = AUDIT_TARGET_TYPES.includes(
    searchParams.targetType as (typeof AUDIT_TARGET_TYPES)[number],
  )
    ? (searchParams.targetType as (typeof AUDIT_TARGET_TYPES)[number])
    : undefined;
  const traceIdParsed = traceIdFilterSchema.safeParse(searchParams.traceId);
  const traceId = traceIdParsed.success ? traceIdParsed.data : undefined;

  return { action, actorType, targetType, traceId };
}

function buildFilterHref(base: AuditSearchParams, overrides: Partial<AuditSearchParams>) {
  const merged = { ...base, ...overrides };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `/audit?${query}` : "/audit";
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<AuditSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const filters = parseFilters(resolvedSearchParams);
  const hasActiveFilters = Boolean(
    filters.action || filters.actorType || filters.targetType || filters.traceId,
  );

  const events = await prisma.auditEvent.findMany({
    where: {
      action: filters.action,
      actorType: filters.actorType,
      targetRecordType: filters.targetType,
      traceId: filters.traceId,
    },
    // createdAt descending, then id descending — a deterministic tiebreak
    // for rows created within the same millisecond, so the ordering (and
    // therefore which RESULT_LIMIT rows appear) never depends on
    // unspecified database row order.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: RESULT_LIMIT,
    select: {
      id: true,
      createdAt: true,
      action: true,
      actorType: true,
      actorUser: { select: { name: true, email: true } },
      targetRecordType: true,
      targetRecordId: true,
      traceId: true,
    },
  });

  return (
    <>
      <h1 className="text-xl font-semibold text-foreground">Audit History</h1>
      <p className="mt-1 text-sm text-muted">
        Read-only, append-only record of program events and workflow actions. Showing up to{" "}
        {RESULT_LIMIT} most recent matching entries.
      </p>

      {/* Filters */}
      <form className="mt-6 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="action" className="text-xs font-medium text-muted">
            Action
          </label>
          <select
            id="action"
            name="action"
            defaultValue={filters.action ?? ""}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="">All</option>
            {AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="actorType" className="text-xs font-medium text-muted">
            Actor type
          </label>
          <select
            id="actorType"
            name="actorType"
            defaultValue={filters.actorType ?? ""}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="">All</option>
            {AUDIT_ACTOR_TYPES.map((actorType) => (
              <option key={actorType} value={actorType}>
                {actorType}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="targetType" className="text-xs font-medium text-muted">
            Target type
          </label>
          <select
            id="targetType"
            name="targetType"
            defaultValue={filters.targetType ?? ""}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          >
            <option value="">All</option>
            {AUDIT_TARGET_TYPES.map((targetType) => (
              <option key={targetType} value={targetType}>
                {targetType.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="traceId" className="text-xs font-medium text-muted">
            Trace ID
          </label>
          <input
            id="traceId"
            name="traceId"
            type="text"
            defaultValue={filters.traceId ?? ""}
            placeholder="Exact trace ID"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
          />
        </div>

        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground transition-opacity hover:opacity-90"
        >
          Apply filters
        </button>
        {hasActiveFilters && (
          <Link href="/audit" className="text-sm text-muted underline hover:text-foreground">
            Reset filters
          </Link>
        )}
      </form>

      {hasActiveFilters && (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted">
          <span>Active filters:</span>
          {filters.action && (
            <ActiveFilterChip
              label={`Action: ${filters.action}`}
              href={buildFilterHref(resolvedSearchParams, { action: "" })}
            />
          )}
          {filters.actorType && (
            <ActiveFilterChip
              label={`Actor: ${filters.actorType}`}
              href={buildFilterHref(resolvedSearchParams, { actorType: "" })}
            />
          )}
          {filters.targetType && (
            <ActiveFilterChip
              label={`Target: ${filters.targetType}`}
              href={buildFilterHref(resolvedSearchParams, { targetType: "" })}
            />
          )}
          {filters.traceId && (
            <ActiveFilterChip
              label={`Trace: ${filters.traceId}`}
              href={buildFilterHref(resolvedSearchParams, { traceId: "" })}
            />
          )}
        </div>
      )}

      {/* Results */}
      <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface">
        {events.length === 0 ? (
          <p className="p-6 text-sm text-muted">
            {hasActiveFilters
              ? "No audit entries match the current filters."
              : "No audit entries have been recorded yet."}
          </p>
        ) : (
          <table className="w-full min-w-max text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs tracking-wide text-muted uppercase">
                <th className="px-4 py-3 font-medium">Timestamp</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Actor</th>
                <th className="px-4 py-3 font-medium">Actor type</th>
                <th className="px-4 py-3 font-medium">Target type</th>
                <th className="px-4 py-3 font-medium">Target ID</th>
                <th className="px-4 py-3 font-medium">Trace ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">
                    {formatTimestamp(event.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={event.action} />
                  </td>
                  <td className="px-4 py-3 text-foreground">{event.actorUser?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-foreground">{event.actorType}</td>
                  <td className="px-4 py-3 text-foreground">{event.targetRecordType ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">
                    {event.targetRecordId ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{event.traceId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ActiveFilterChip({ label, href }: { label: string; href: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 hover:bg-surface"
    >
      {label}
      <span aria-hidden>×</span>
    </Link>
  );
}
