import { prisma } from "../db";
import { entityIdSchema } from "./schemas";
import {
  notFound,
  ok,
  validationError,
  type ImpactRelationship,
  type ServiceResult,
} from "./types";
import { traverseDependencyChain } from "./dependencies";

export interface ImpactedRequirement {
  requirementId: string;
  title: string;
  status: string;
  priority: string;
  relationship: "direct";
  reason: string;
}

export interface ImpactedMilestone {
  milestoneId: string;
  name: string;
  plannedDate: string;
  status: string;
  relationship: ImpactRelationship;
  reason: string;
}

/**
 * Requirements directly linked to a component via RequirementComponent —
 * the only path from Component to Requirement in this schema (no
 * intermediate hop), so every result here is "direct" by construction.
 */
export async function getImpactedRequirements(
  componentId: string,
): Promise<ServiceResult<ImpactedRequirement[]>> {
  const parsed = entityIdSchema.safeParse(componentId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const component = await prisma.component.findUnique({
    where: { id: parsed.data },
    select: { id: true },
  });
  if (!component) {
    return notFound("COMPONENT", parsed.data);
  }

  const links = await prisma.requirementComponent.findMany({
    where: { componentId: parsed.data },
    select: {
      requirement: { select: { id: true, title: true, status: true, priority: true } },
    },
  });

  // Deduplicated by requirement ID via Map keying — RequirementComponent's
  // composite primary key already prevents a duplicate row from existing,
  // but a plain object result should never rely on a DB constraint alone to
  // guarantee its own invariant.
  const byId = new Map<string, ImpactedRequirement>();
  for (const link of links) {
    byId.set(link.requirement.id, {
      requirementId: link.requirement.id,
      title: link.requirement.title,
      status: link.requirement.status,
      priority: link.requirement.priority,
      relationship: "direct",
      reason: `Directly linked to component "${parsed.data}".`,
    });
  }

  return ok([...byId.values()].sort((a, b) => a.requirementId.localeCompare(b.requirementId)));
}

/**
 * Milestones affected by a component: direct (Milestone.componentId
 * matches) plus dependency-derived (downstream of any direct milestone in
 * the Dependency graph — a delay to a direct milestone cascades to
 * whatever depends on it). Never inferred from free-text similarity.
 */
export async function getImpactedMilestones(
  componentId: string,
): Promise<ServiceResult<ImpactedMilestone[]>> {
  const parsed = entityIdSchema.safeParse(componentId);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const component = await prisma.component.findUnique({
    where: { id: parsed.data },
    select: { id: true, programId: true },
  });
  if (!component) {
    return notFound("COMPONENT", parsed.data);
  }

  // One query for every milestone and every dependency edge in the program
  // — used both to find the direct set and to look up dependency-derived
  // milestones' details, instead of one extra query per derived node.
  const [programMilestones, dependencyRows] = await Promise.all([
    prisma.milestone.findMany({
      where: { programId: component.programId },
      select: { id: true, componentId: true, name: true, plannedDate: true, status: true },
    }),
    prisma.dependency.findMany({
      where: { programId: component.programId },
      select: { id: true, fromMilestoneId: true, toMilestoneId: true },
    }),
  ]);

  const milestonesById = new Map(programMilestones.map((m) => [m.id, m]));
  const directMilestones = programMilestones.filter((m) => m.componentId === parsed.data);
  const directIds = new Set(directMilestones.map((m) => m.id));

  const result = new Map<string, ImpactedMilestone>();
  for (const milestone of directMilestones) {
    result.set(milestone.id, {
      milestoneId: milestone.id,
      name: milestone.name,
      plannedDate: milestone.plannedDate.toISOString().slice(0, 10),
      status: milestone.status,
      relationship: "direct",
      reason: `Milestone belongs directly to component "${parsed.data}".`,
    });
  }

  const dependencyDerivedIds = new Set<string>();
  for (const directId of directIds) {
    const { downstream } = traverseDependencyChain(dependencyRows, directId);
    for (const node of downstream) dependencyDerivedIds.add(node.milestoneId);
  }
  // Direct membership always wins if a milestone is reachable both ways —
  // it's already correctly represented above; only add the ones not
  // already direct.
  for (const id of dependencyDerivedIds) {
    if (result.has(id)) continue;
    const milestone = milestonesById.get(id);
    if (!milestone) continue;
    result.set(id, {
      milestoneId: milestone.id,
      name: milestone.name,
      plannedDate: milestone.plannedDate.toISOString().slice(0, 10),
      status: milestone.status,
      relationship: "dependency-derived",
      reason: `Downstream, via the dependency graph, of a milestone directly on component "${parsed.data}".`,
    });
  }

  return ok([...result.values()].sort((a, b) => a.milestoneId.localeCompare(b.milestoneId)));
}
