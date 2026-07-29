// Framework-independent digital-thread read model (Phase 7, PART A). This
// module must never import React Flow or any UI framework — apps/web maps
// these DTOs onto @xyflow/react node/edge shapes, not the other way around.
// See docs/DECISIONS.md, "Phase 7 thread graph design".

/**
 * Fixed node-kind vocabulary. No graph node is ever created for a
 * join-table row (RequirementComponent, TestRequirement, Dependency,
 * SourceReference) — those are represented as edges or edge metadata.
 */
export const THREAD_NODE_KINDS = [
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
  "ANALYSIS_RUN",
  "MITIGATION_OPTION",
  "DECISION",
  "PROPOSED_CHANGE",
] as const;
export type ThreadNodeKind = (typeof THREAD_NODE_KINDS)[number];

/** Fixed edge-kind vocabulary — see build-program-thread.ts for the mapping from each Prisma relationship to one of these kinds. */
export const THREAD_EDGE_KINDS = [
  "CONTAINS",
  "ASSOCIATED_WITH",
  "SATISFIES",
  "SCHEDULED_ON",
  "DEPENDS_ON",
  "VERIFIED_BY",
  "HAS_DEFECT",
  "HAS_RISK",
  "HAS_BUDGET",
  "SUPPLIED",
  "TRIGGERED",
  "ANALYZED_BY",
  "CITED",
  "PROPOSED",
  "DECIDED",
  "TARGETS",
] as const;
export type ThreadEdgeKind = (typeof THREAD_EDGE_KINDS)[number];

export type ThreadMetadataValue = string | number | boolean | null;

export interface ThreadNode {
  id: string;
  kind: ThreadNodeKind;
  recordId: string;
  label: string;
  subtitle: string | null;
  status: string | null;
  href: string | null;
  metadata: Record<string, ThreadMetadataValue>;
}

export interface ThreadEdge {
  id: string;
  kind: ThreadEdgeKind;
  source: string;
  target: string;
  label: string | null;
  directed: boolean;
  metadata: Record<string, ThreadMetadataValue>;
}

export interface ProgramThreadGraph {
  programId: string;
  nodes: ThreadNode[];
  edges: ThreadEdge[];
  nodeCount: number;
  edgeCount: number;
}

// Named limits (§6) — the seeded EdgeLink-X program (well under 100 domain
// records plus a handful of workflow records) must fit comfortably below
// every one of these.
export const MAX_THREAD_NODES = 500;
export const MAX_THREAD_EDGES = 1000;
export const MAX_THREAD_LABEL_LENGTH = 200;
export const MAX_THREAD_METADATA_ENTRIES = 12;

export function threadNodeId(kind: ThreadNodeKind, recordId: string): string {
  return `${kind}:${recordId}`;
}
