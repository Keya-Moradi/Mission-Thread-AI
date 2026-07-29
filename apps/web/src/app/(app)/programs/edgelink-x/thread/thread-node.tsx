"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { StatusBadge } from "@/components/status-badge";
import type { ThreadNodeKind } from "@missionthread/core";

// Workflow-kind nodes get an accent-tinted border so the run -> option ->
// decision chain reads visually distinct from domain data — but the kind
// label text below is the actual source of truth, never color alone.
const WORKFLOW_KINDS = new Set<ThreadNodeKind>([
  "ANALYSIS_RUN",
  "MITIGATION_OPTION",
  "DECISION",
  "PROPOSED_CHANGE",
]);

export interface ThreadNodeData {
  kind: ThreadNodeKind;
  recordId: string;
  label: string;
  subtitle: string | null;
  status: string | null;
  dimmed: boolean;
  [key: string]: unknown;
}

export function ThreadFlowNode({ data, selected }: NodeProps) {
  const nodeData = data as ThreadNodeData;
  const isWorkflow = WORKFLOW_KINDS.has(nodeData.kind);

  return (
    <div
      className={`w-56 rounded-md border bg-surface p-2.5 text-left shadow-sm transition-opacity ${
        selected
          ? "border-accent ring-2 ring-accent/40"
          : isWorkflow
            ? "border-accent/50"
            : "border-border"
      } ${nodeData.dimmed ? "opacity-30" : "opacity-100"}`}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted" />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-wide text-muted uppercase">
          {nodeData.kind.replaceAll("_", " ")}
        </span>
        {nodeData.status && <StatusBadge status={nodeData.status} />}
      </div>
      <div className="mt-1 truncate text-sm font-medium text-foreground" title={nodeData.label}>
        {nodeData.label}
      </div>
      {nodeData.subtitle && (
        <div className="mt-0.5 truncate text-xs text-muted" title={nodeData.subtitle}>
          {nodeData.subtitle}
        </div>
      )}
      <div className="mt-1 truncate font-mono text-[10px] text-muted" title={nodeData.recordId}>
        {nodeData.recordId}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted" />
    </div>
  );
}

export const THREAD_NODE_TYPES = { threadNode: ThreadFlowNode };
