import { prisma } from "../db";
import { notFound, ok, validationError, type ServiceResult } from "../analysis/types";
import { getVerificationGaps } from "../analysis/verification";
import { getRelatedDefects } from "../analysis/defects";
import { requirementInputSchema } from "./schemas";
import { boundMcpText } from "./types";
import type { RequirementDetail } from "./types";

export async function getRequirement(input: unknown): Promise<ServiceResult<RequirementDetail>> {
  const parsed = requirementInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const { requirementId } = parsed.data;

  const requirement = await prisma.requirement.findUnique({
    where: { id: requirementId },
    select: {
      id: true,
      title: true,
      priority: true,
      status: true,
      components: { select: { component: { select: { id: true, name: true } } } },
      testCases: {
        select: { testCase: { select: { id: true, name: true, outcome: true } } },
      },
    },
  });
  if (!requirement) {
    return notFound("REQUIREMENT", requirementId);
  }

  const [gapsResult, defectsResult] = await Promise.all([
    getVerificationGaps([requirementId]),
    getRelatedDefects([requirementId]),
  ]);

  const gap = gapsResult.ok ? gapsResult.data.results[0] : undefined;

  return ok({
    requirementId: requirement.id,
    title: boundMcpText(requirement.title),
    priority: requirement.priority,
    status: requirement.status,
    linkedComponents: requirement.components
      .map((link) => ({ componentId: link.component.id, name: boundMcpText(link.component.name) }))
      .sort((a, b) => a.componentId.localeCompare(b.componentId)),
    linkedTests: requirement.testCases
      .map((link) => ({
        testCaseId: link.testCase.id,
        name: boundMcpText(link.testCase.name),
        outcome: link.testCase.outcome,
      }))
      .sort((a, b) => a.testCaseId.localeCompare(b.testCaseId)),
    relatedDefects: defectsResult.ok
      ? defectsResult.data.results.map((defect) => ({
          defectId: defect.defectId,
          severity: defect.severity,
          status: defect.status,
        }))
      : [],
    hasVerificationGap: gap ? gap.gapCategory !== "NONE" : false,
    verificationGapCategory: gap?.gapCategory ?? "NO_COVERAGE",
  });
}
