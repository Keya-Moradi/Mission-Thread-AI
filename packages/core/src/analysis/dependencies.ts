import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import { notFound, ok, validationError, type ServiceResult } from "./types";

export interface DependencyEdge {
  id: string;
  fromMilestoneId: string;
  toMilestoneId: string;
}

export interface DependencyChainNode {
  milestoneId: string;
  name: string;
  status: string;
  plannedDate: string;
  /** Hop count from the queried milestone: 1 = immediate neighbor. */
  depth: number;
  /** The Dependency row this node was first reached through. */
  viaDependencyId: string;
}

export interface DependencyChainResult {
  milestoneId: string;
  /**
   * Prerequisites — milestones this one depends on (transitive), reached by
   * following fromMilestoneId edges backward from toMilestoneId === current.
   * See docs/DECISIONS.md, "Dependency traversal direction".
   */
  upstream: DependencyChainNode[];
  /**
   * Dependents — milestones that depend on this one (transitive), reached
   * by following toMilestoneId edges forward from fromMilestoneId === current.
   */
  downstream: DependencyChainNode[];
}

interface RawChainNode {
  milestoneId: string;
  depth: number;
  viaDependencyId: string;
}

/**
 * Pure, DB-free BFS over an in-memory edge list. Exported so cycle and
 * duplicate-edge handling can be unit-tested directly with fabricated data,
 * without seeding an actual cycle into Postgres — see docs/DECISIONS.md.
 * BFS (not DFS) so `depth` is always the shortest-path hop count, and a
 * `visited` set seeded with `startId` guarantees termination: a node is
 * only ever enqueued once, so a cycle that loops back to an already-visited
 * node (including the start node itself) simply stops there instead of
 * looping forever, and a duplicate edge can never produce a duplicate node
 * in the result.
 */
export function traverseDependencyChain(
  edges: readonly DependencyEdge[],
  startId: string,
): { upstream: RawChainNode[]; downstream: RawChainNode[] } {
  return {
    upstream: bfsDirection(edges, startId, "upstream"),
    downstream: bfsDirection(edges, startId, "downstream"),
  };
}

function bfsDirection(
  edges: readonly DependencyEdge[],
  startId: string,
  direction: "upstream" | "downstream",
): RawChainNode[] {
  const visited = new Set<string>([startId]);
  const result: RawChainNode[] = [];
  let frontier: string[] = [startId];
  let depth = 0;

  while (frontier.length > 0) {
    depth += 1;
    const nextFrontier: string[] = [];
    for (const currentId of frontier) {
      const neighbors =
        direction === "upstream"
          ? edges.filter((edge) => edge.toMilestoneId === currentId)
          : edges.filter((edge) => edge.fromMilestoneId === currentId);

      for (const edge of neighbors) {
        const neighborId = direction === "upstream" ? edge.fromMilestoneId : edge.toMilestoneId;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        result.push({ milestoneId: neighborId, depth, viaDependencyId: edge.id });
        nextFrontier.push(neighborId);
      }
    }
    frontier = nextFrontier;
  }

  return result;
}

export async function getDependencyChain(
  milestoneId: string,
): Promise<ServiceResult<DependencyChainResult>> {
  const parsed = entityIdSchema.safeParse(milestoneId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const milestone = await prisma.milestone.findUnique({
    where: { id: parsed.data },
    select: { id: true, programId: true },
  });
  if (!milestone) {
    return notFound("MILESTONE", parsed.data);
  }

  // One query for every edge and every milestone in the program, not one
  // query per traversal hop — avoids N+1 for a graph this small.
  const [dependencyRows, milestoneRows] = await Promise.all([
    prisma.dependency.findMany({
      where: { programId: milestone.programId },
      select: { id: true, fromMilestoneId: true, toMilestoneId: true },
    }),
    prisma.milestone.findMany({
      where: { programId: milestone.programId },
      select: { id: true, name: true, status: true, plannedDate: true },
    }),
  ]);

  const milestonesById = new Map(milestoneRows.map((row) => [row.id, row]));
  const { upstream, downstream } = traverseDependencyChain(dependencyRows, parsed.data);

  return ok({
    milestoneId: parsed.data,
    upstream: enrich(upstream, milestonesById),
    downstream: enrich(downstream, milestonesById),
  });
}

function enrich(
  nodes: RawChainNode[],
  milestonesById: Map<string, { id: string; name: string; status: string; plannedDate: Date }>,
): DependencyChainNode[] {
  return nodes
    .map((node) => {
      const milestone = milestonesById.get(node.milestoneId);
      return {
        milestoneId: node.milestoneId,
        // Every milestoneId in a Dependency row is FK-constrained to an
        // existing Milestone, so this fallback is unreachable in practice —
        // kept only so a lookup miss fails safe (empty strings) instead of
        // throwing, consistent with this module never throwing for data issues.
        name: milestone?.name ?? "",
        status: milestone?.status ?? "",
        plannedDate: milestone ? milestone.plannedDate.toISOString().slice(0, 10) : "",
        depth: node.depth,
        viaDependencyId: node.viaDependencyId,
      };
    })
    .sort((a, b) => a.depth - b.depth || a.milestoneId.localeCompare(b.milestoneId));
}
