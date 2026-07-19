// Stable data-testid hooks so the smoke test (apps/web/scripts/smoke-test.mjs)
// can read an exact labeled value instead of searching the page for a bare
// number that could coincidentally appear elsewhere.
export function StatCard({
  testId,
  label,
  value,
  unavailable,
}: {
  testId: string;
  label: string;
  value: string | number;
  /** True when the underlying calculation failed — shows an explicit
   * "Unavailable" state instead of inventing a zero. */
  unavailable?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div
        className={`text-2xl font-semibold ${unavailable ? "text-muted" : "text-foreground"}`}
        data-testid={`stat-value-${testId}`}
      >
        {unavailable ? "—" : value}
      </div>
      <div className="mt-1 text-sm text-muted" data-testid={`stat-label-${testId}`}>
        {label}
        {unavailable && <span className="ml-1 text-danger">(unavailable)</span>}
      </div>
    </div>
  );
}
