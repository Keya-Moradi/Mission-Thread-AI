import { prisma } from "../db";
import { entityIdArraySchema, formatZodError } from "./schemas";
import { ok, validationError, type ServiceResult } from "./types";

export interface RelatedDefect {
  defectId: string;
  title: string;
  severity: string;
  status: string;
  testCaseId: string;
  /** Which of the requested requirement IDs this defect connects back to. */
  requirementIds: string[];
  relationshipPath: string;
}

export interface RelatedDefectsResponse {
  results: RelatedDefect[];
  missingRequirementIds: string[];
}

interface DefectTestLink {
  defectId: string;
  title: string;
  severity: string;
  status: string;
  testCaseId: string;
}

interface TestRequirementLink {
  testCaseId: string;
  requirementId: string;
}

/**
 * Pure grouping step, unit-testable without a database. A defect connects
 * to a requirement only through Defect.relatedTestCaseId -> TestCase ->
 * TestRequirement.requirementId (never by matching text) — this function
 * joins those two already-fetched lists in memory. A single defect can
 * legitimately list multiple requirement IDs when its related test case
 * verifies more than one requirement.
 */
export function groupRelatedDefects(
  defects: readonly DefectTestLink[],
  testRequirementLinks: readonly TestRequirementLink[],
): RelatedDefect[] {
  const requirementIdsByTestCase = new Map<string, string[]>();
  for (const link of testRequirementLinks) {
    const entry = requirementIdsByTestCase.get(link.testCaseId) ?? [];
    if (!entry.includes(link.requirementId)) entry.push(link.requirementId);
    requirementIdsByTestCase.set(link.testCaseId, entry);
  }

  return defects
    .map((defect) => {
      const requirementIds = (requirementIdsByTestCase.get(defect.testCaseId) ?? []).slice().sort();
      return {
        defectId: defect.defectId,
        title: defect.title,
        severity: defect.severity,
        status: defect.status,
        testCaseId: defect.testCaseId,
        requirementIds,
        relationshipPath: requirementIds
          .map((requirementId) => `${requirementId} -> ${defect.testCaseId} -> ${defect.defectId}`)
          .join("; "),
      };
    })
    .sort((a, b) => a.defectId.localeCompare(b.defectId));
}

export async function getRelatedDefects(
  requirementIds: string[],
): Promise<ServiceResult<RelatedDefectsResponse>> {
  const parsed = entityIdArraySchema.safeParse(requirementIds);
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error));
  }
  if (parsed.data.length === 0) {
    return ok({ results: [], missingRequirementIds: [] });
  }

  const [foundRequirements, testRequirementLinks] = await Promise.all([
    prisma.requirement.findMany({
      where: { id: { in: parsed.data } },
      select: { id: true },
    }),
    prisma.testRequirement.findMany({
      where: { requirementId: { in: parsed.data } },
      select: { testCaseId: true, requirementId: true },
    }),
  ]);

  const foundIds = new Set(foundRequirements.map((r) => r.id));
  const missingRequirementIds = parsed.data.filter((id) => !foundIds.has(id)).sort();

  const testCaseIds = [...new Set(testRequirementLinks.map((link) => link.testCaseId))];
  const defectRows =
    testCaseIds.length === 0
      ? []
      : await prisma.defect.findMany({
          where: { relatedTestCaseId: { in: testCaseIds } },
          select: { id: true, title: true, severity: true, status: true, relatedTestCaseId: true },
        });

  const defectLinks: DefectTestLink[] = defectRows.map((defect) => ({
    defectId: defect.id,
    title: defect.title,
    severity: defect.severity,
    status: defect.status,
    // Narrowed by the query itself (relatedTestCaseId: { in: testCaseIds }),
    // so this is always a string here, never null.
    testCaseId: defect.relatedTestCaseId as string,
  }));

  const results = groupRelatedDefects(defectLinks, testRequirementLinks);

  return ok({ results, missingRequirementIds });
}
