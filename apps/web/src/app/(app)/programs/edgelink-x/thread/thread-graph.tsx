"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { ProgramThreadGraph, ThreadNodeKind } from "@missionthread/core";
import { computeThreadLayout } from "./thread-layout";
import { THREAD_NODE_TYPES, type ThreadNodeData } from "./thread-node";
import { ThreadDetails } from "./thread-details";
import { DOMAIN_NODE_KINDS, ThreadFilters, WORKFLOW_NODE_KINDS } from "./thread-filters";

const ALL_KINDS = new Set<ThreadNodeKind>([...DOMAIN_NODE_KINDS, ...WORKFLOW_NODE_KINDS]);

function matchesSearch(label: string, recordId: string, search: string): boolean {
  if (search.trim().length === 0) return true;
  const needle = search.trim().toLowerCase();
  return label.toLowerCase().includes(needle) || recordId.toLowerCase().includes(needle);
}

function ThreadGraphInner({ graph }: { graph: ProgramThreadGraph }) {
  const { fitView } = useReactFlow();
  const [search, setSearch] = useState("");
  const [visibleKinds, setVisibleKinds] = useState<Set<ThreadNodeKind>>(new Set(ALL_KINDS));
  const [showCitations, setShowCitations] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const positions = useMemo(() => computeThreadLayout(graph.nodes), [graph.nodes]);

  const matchedNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
      if (visibleKinds.has(node.kind) && matchesSearch(node.label, node.recordId, search)) {
        ids.add(node.id);
      }
    }
    return ids;
  }, [graph.nodes, visibleKinds, search]);

  const flowNodes: Node[] = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: "threadNode",
        position: positions[node.id] ?? { x: 0, y: 0 },
        data: {
          kind: node.kind,
          recordId: node.recordId,
          label: node.label,
          subtitle: node.subtitle,
          status: node.status,
          dimmed: !matchedNodeIds.has(node.id),
        } satisfies ThreadNodeData,
        selected: node.id === selectedNodeId,
        draggable: false,
        connectable: false,
      })),
    [graph.nodes, positions, matchedNodeIds, selectedNodeId],
  );

  const visibleEdges = useMemo(
    () =>
      graph.edges.filter((edge) => {
        if (edge.kind === "CITED" && !showCitations) return false;
        return matchedNodeIds.has(edge.source) && matchedNodeIds.has(edge.target);
      }),
    [graph.edges, matchedNodeIds, showCitations],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      visibleEdges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        label: edge.label ?? undefined,
        style:
          edge.kind === "CITED"
            ? { stroke: "var(--accent)", strokeDasharray: "4 3" }
            : { stroke: "var(--border)" },
        labelStyle: { fill: "var(--muted)", fontSize: 10 },
        markerEnd: edge.directed
          ? { type: MarkerType.ArrowClosed, color: "var(--muted)" }
          : undefined,
      })),
    [visibleEdges],
  );

  const handleNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    setSelectedNodeId((current) => (current === node.id ? null : node.id));
  }, []);

  const handleReset = useCallback(() => {
    setSearch("");
    setVisibleKinds(new Set(ALL_KINDS));
    setShowCitations(true);
    setSelectedNodeId(null);
    fitView();
  }, [fitView]);

  const handleToggleKind = useCallback((kind: ThreadNodeKind) => {
    setVisibleKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) {
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  }, []);

  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="flex flex-col gap-4">
      <ThreadFilters
        search={search}
        onSearchChange={setSearch}
        visibleKinds={visibleKinds}
        onToggleKind={handleToggleKind}
        showCitations={showCitations}
        onToggleCitations={() => setShowCitations((v) => !v)}
        onReset={handleReset}
        nodeCount={graph.nodeCount}
        visibleNodeCount={matchedNodeIds.size}
        edgeCount={graph.edgeCount}
        visibleEdgeCount={visibleEdges.length}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_280px]">
        <div className="h-[500px] overflow-hidden rounded-lg border border-border bg-background sm:h-[600px] lg:h-[720px]">
          {graph.nodes.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              This program has no thread records yet.
            </div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={THREAD_NODE_TYPES}
              onNodeClick={handleNodeClick}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={true}
              deleteKeyCode={null}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable />
            </ReactFlow>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Legend />
          <ThreadDetails node={selectedNode} onClose={() => setSelectedNodeId(null)} />
        </div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 text-xs">
      <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">Legend</h3>
      <ul className="mt-2 flex flex-col gap-1.5 text-foreground">
        <li>
          <span className="font-medium">Domain records</span> — program, component, requirement,
          milestone, risk, supplier, test, defect, budget, event.
        </li>
        <li>
          <span className="font-medium">Workflow records</span> — analysis run, mitigation option,
          decision, proposed change (accent-bordered).
        </li>
        <li>
          <span className="font-medium">Dashed accent edges</span> — evidence citations from an
          analysis run.
        </li>
        <li>Every node shows its kind and status as text — color is never the only signal.</li>
      </ul>
    </div>
  );
}

export function ThreadGraph({ graph }: { graph: ProgramThreadGraph }) {
  return (
    <ReactFlowProvider>
      <ThreadGraphInner graph={graph} />
    </ReactFlowProvider>
  );
}
