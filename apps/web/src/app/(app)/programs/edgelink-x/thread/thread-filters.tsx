"use client";

import type { ThreadNodeKind } from "@missionthread/core";

export const DOMAIN_NODE_KINDS: readonly ThreadNodeKind[] = [
  "PROGRAM",
  "COMPONENT",
  "REQUIREMENT",
  "MILESTONE",
  "RISK",
  "SUPPLIER",
  "TEST_CASE",
  "DEFECT",
  "BUDGET_ITEM",
  "PROGRAM_EVENT",
];

export const WORKFLOW_NODE_KINDS: readonly ThreadNodeKind[] = [
  "ANALYSIS_RUN",
  "MITIGATION_OPTION",
  "DECISION",
  "PROPOSED_CHANGE",
];

function KindGroup({
  title,
  kinds,
  visibleKinds,
  onToggleKind,
}: {
  title: string;
  kinds: readonly ThreadNodeKind[];
  visibleKinds: ReadonlySet<ThreadNodeKind>;
  onToggleKind: (kind: ThreadNodeKind) => void;
}) {
  return (
    <fieldset>
      <legend className="text-xs font-medium tracking-wide text-muted uppercase">{title}</legend>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {kinds.map((kind) => {
          const active = visibleKinds.has(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={active}
              onClick={() => onToggleKind(kind)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                active
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-background text-muted"
              }`}
            >
              {kind.replaceAll("_", " ")}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ThreadFilters({
  search,
  onSearchChange,
  visibleKinds,
  onToggleKind,
  showCitations,
  onToggleCitations,
  onReset,
  nodeCount,
  visibleNodeCount,
  edgeCount,
  visibleEdgeCount,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  visibleKinds: ReadonlySet<ThreadNodeKind>;
  onToggleKind: (kind: ThreadNodeKind) => void;
  showCitations: boolean;
  onToggleCitations: () => void;
  onReset: () => void;
  nodeCount: number;
  visibleNodeCount: number;
  edgeCount: number;
  visibleEdgeCount: number;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-[220px] flex-1">
          <label
            htmlFor="thread-search"
            className="text-xs font-medium tracking-wide text-muted uppercase"
          >
            Search by label or record ID
          </label>
          <input
            id="thread-search"
            type="text"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="e.g. EC-440, COMP-BATTERY"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground"
          />
        </div>
        <button
          type="button"
          onClick={onReset}
          className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-surface"
        >
          Reset view
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        <KindGroup
          title="Domain records"
          kinds={DOMAIN_NODE_KINDS}
          visibleKinds={visibleKinds}
          onToggleKind={onToggleKind}
        />
        <KindGroup
          title="Workflow records"
          kinds={WORKFLOW_NODE_KINDS}
          visibleKinds={visibleKinds}
          onToggleKind={onToggleKind}
        />
        <fieldset>
          <legend className="text-xs font-medium tracking-wide text-muted uppercase">
            Citation edges
          </legend>
          <div className="mt-1.5">
            <button
              type="button"
              aria-pressed={showCitations}
              onClick={onToggleCitations}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                showCitations
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-border bg-background text-muted"
              }`}
            >
              {showCitations ? "Showing evidence citations" : "Evidence citations hidden"}
            </button>
          </div>
        </fieldset>
      </div>

      <p className="mt-3 text-xs text-muted">
        Showing {visibleNodeCount} of {nodeCount} nodes, {visibleEdgeCount} of {edgeCount} edges.
      </p>
    </div>
  );
}
