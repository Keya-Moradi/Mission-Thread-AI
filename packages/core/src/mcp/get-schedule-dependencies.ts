import { validationError, type ServiceResult } from "../analysis/types";
import { getDependencyChain, type DependencyChainNode } from "../analysis/dependencies";
import { scheduleDependenciesInputSchema } from "./schemas";
import { boundMcpText, MCP_LIMITS } from "./types";
import type { DependencyNode, ScheduleDependencies } from "./types";

function withinDepth(
  nodes: DependencyChainNode[],
  maxDepth: number,
): {
  kept: DependencyChainNode[];
  truncated: boolean;
} {
  const kept = nodes.filter((node) => node.depth <= maxDepth);
  return { kept, truncated: kept.length < nodes.length };
}

// Milestone name is the only free-text field on a DependencyChainNode —
// status/plannedDate/depth/viaDependencyId are all enum-like, date, or
// numeric/ID values, never truncated (see §14, "Apply maxTextLength").
function boundNode(node: DependencyChainNode): DependencyNode {
  return { ...node, name: boundMcpText(node.name) };
}

export async function getScheduleDependencies(
  input: unknown,
): Promise<ServiceResult<ScheduleDependencies>> {
  const parsed = scheduleDependenciesInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const { milestoneId } = parsed.data;
  // Always clamped to MCP_LIMITS.maxDependencyDepth by the schema itself
  // (z.number().max(...)) — this is a defense-in-depth re-clamp, not the
  // primary enforcement, so a future schema change can never accidentally
  // remove the bound this service actually honors.
  const maxDepth = Math.min(
    parsed.data.maxDepth ?? MCP_LIMITS.defaultDependencyDepth,
    MCP_LIMITS.maxDependencyDepth,
  );

  const result = await getDependencyChain(milestoneId);
  if (!result.ok) {
    return result;
  }

  const upstream = withinDepth(result.data.upstream, maxDepth);
  const downstream = withinDepth(result.data.downstream, maxDepth);
  const missingData: string[] = [];
  if (upstream.truncated || downstream.truncated) {
    missingData.push(
      `Dependency chain was truncated at maxDepth=${maxDepth}; deeper prerequisites/dependents exist but were not returned.`,
    );
  }

  return {
    ok: true,
    data: {
      milestoneId: result.data.milestoneId,
      maxDepth,
      upstream: upstream.kept.map(boundNode),
      downstream: downstream.kept.map(boundNode),
      truncatedByMaxDepth: upstream.truncated || downstream.truncated,
      missingData,
    },
  };
}
