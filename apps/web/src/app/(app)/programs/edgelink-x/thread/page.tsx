import Link from "next/link";
import {
  buildProgramThread,
  PROGRAM_ID,
  THREAD_NODE_KINDS,
  type ThreadNode,
} from "@missionthread/core";
import { requireSession } from "@/lib/auth-helpers";
import { StatusBadge } from "@/components/status-badge";
import { ThreadGraph } from "./thread-graph";

// Available to all 3 roles (PM, Engineering Lead, Executive Viewer) — this
// route is strictly read-only, so there is no mutation to authorize beyond
// the session check every (app) route already requires.
export default async function ThreadPage() {
  await requireSession();
  const result = await buildProgramThread(PROGRAM_ID);

  if (!result.ok) {
    return (
      <div
        role="alert"
        className="rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      >
        The digital thread could not be built ({result.error.code}). {result.error.message}
      </div>
    );
  }

  const graph = result.data;
  const nodesByKind = new Map<string, ThreadNode[]>();
  for (const node of graph.nodes) {
    const list = nodesByKind.get(node.kind) ?? [];
    list.push(node);
    nodesByKind.set(node.kind, list);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Digital thread</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          A read-only, database-driven graph of every record in EdgeLink-X and how they connect —
          from components and requirements through analysis runs and approved changes.
        </p>
      </div>

      <ThreadGraph graph={graph} />

      <details className="rounded-lg border border-border bg-surface p-4">
        <summary className="cursor-pointer text-sm font-semibold text-foreground">
          Thread records and relationships (accessible, non-canvas view)
        </summary>

        <div className="mt-4 flex flex-col gap-6">
          {THREAD_NODE_KINDS.map((kind) => {
            const nodes = nodesByKind.get(kind);
            if (!nodes || nodes.length === 0) return null;
            return (
              <section key={kind}>
                <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
                  {kind.replaceAll("_", " ")} ({nodes.length})
                </h3>
                <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                  {nodes.map((node) => (
                    <li key={node.id} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted">{node.recordId}</span>
                      {node.href ? (
                        <Link href={node.href} className="text-accent hover:underline">
                          {node.label}
                        </Link>
                      ) : (
                        <span className="text-foreground">{node.label}</span>
                      )}
                      {node.status && <StatusBadge status={node.status} />}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}

          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">
              Relationships ({graph.edges.length})
            </h3>
            <ul className="mt-2 flex flex-col gap-1 text-sm">
              {graph.edges.map((edge) => {
                const sourceLabel = nodeLabelFor(graph.nodes, edge.source);
                const targetLabel = nodeLabelFor(graph.nodes, edge.target);
                return (
                  <li key={edge.id} className="text-foreground">
                    <span className="text-muted">{sourceLabel}</span>{" "}
                    <span className="text-xs text-muted">
                      {edge.label ?? edge.kind.replaceAll("_", " ")} →
                    </span>{" "}
                    <span className="text-muted">{targetLabel}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </details>
    </div>
  );
}

function nodeLabelFor(nodes: ThreadNode[], nodeId: string): string {
  return nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}
