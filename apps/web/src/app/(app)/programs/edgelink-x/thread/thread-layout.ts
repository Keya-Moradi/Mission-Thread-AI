import type { ThreadNode, ThreadNodeKind } from "@missionthread/core";

// Type-only import above: this module is bundled into the client (it's
// imported by the "use client" thread-graph.tsx), so importing any runtime
// value from @missionthread/core's root barrel would pull Prisma/pg into
// the browser bundle (that barrel also re-exports ./db). See
// docs/DECISIONS.md, "Phase 7 thread layout must not import core runtime
// values" — the same class of issue as the Playwright db-safety subpath
// export fix in Phase 5.

// Deterministic, layered left-to-right layout — a pure function of the node
// list itself (kind + recordId), never database return order, Date.now(),
// Math.random(), or viewport size. See docs/DECISIONS.md, "Phase 7
// deterministic thread layout": dagre/ELK were deliberately not added — a
// program this size (well under MAX_THREAD_NODES) lays out cleanly with a
// fixed column-per-kind scheme.
const COLUMN_BY_KIND: Record<ThreadNodeKind, number> = {
  PROGRAM: 0,
  SUPPLIER: 1,
  PROGRAM_EVENT: 1,
  COMPONENT: 2,
  REQUIREMENT: 3,
  MILESTONE: 3,
  RISK: 3,
  BUDGET_ITEM: 3,
  TEST_CASE: 4,
  DEFECT: 4,
  ANALYSIS_RUN: 5,
  MITIGATION_OPTION: 6,
  DECISION: 7,
  PROPOSED_CHANGE: 7,
};

export const THREAD_LAYOUT_COLUMN_WIDTH = 260;
export const THREAD_LAYOUT_ROW_HEIGHT = 96;

export interface ThreadNodePosition {
  x: number;
  y: number;
}

const KIND_ORDER = new Map(
  (Object.keys(COLUMN_BY_KIND) as ThreadNodeKind[]).map((kind, index) => [kind, index]),
);

/**
 * Positions every node by (column-for-kind, deterministic row within that
 * column). Row order within a column is (kind order in THREAD_NODE_KINDS,
 * then recordId) so two calls with the same node set — regardless of the
 * array's incoming order — always produce identical positions.
 */
export function computeThreadLayout(
  nodes: readonly ThreadNode[],
): Record<string, ThreadNodePosition> {
  const byColumn = new Map<number, ThreadNode[]>();
  for (const node of nodes) {
    const column = COLUMN_BY_KIND[node.kind];
    const list = byColumn.get(column) ?? [];
    list.push(node);
    byColumn.set(column, list);
  }

  const positions: Record<string, ThreadNodePosition> = {};
  for (const [column, columnNodes] of byColumn) {
    const sorted = [...columnNodes].sort((a, b) => {
      const kindDelta = (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0);
      return kindDelta !== 0 ? kindDelta : a.recordId.localeCompare(b.recordId);
    });
    sorted.forEach((node, row) => {
      positions[node.id] = {
        x: column * THREAD_LAYOUT_COLUMN_WIDTH,
        y: row * THREAD_LAYOUT_ROW_HEIGHT,
      };
    });
  }

  return positions;
}
