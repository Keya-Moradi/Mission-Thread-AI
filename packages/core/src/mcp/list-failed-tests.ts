import { prisma } from "../db";
import { notFound, ok, validationError, type ServiceResult } from "../analysis/types";
import { failedTestsInputSchema } from "./schemas";
import { boundMcpText, MCP_LIMITS } from "./types";
import type { FailedTest } from "./types";

// Only TestOutcome.FAILED — BLOCKED and NOT_RUN are never reinterpreted as
// failed (§14). get_program_summary's testOutcomeCounts is where a caller
// finds BLOCKED/NOT_RUN totals.
export async function listFailedTests(input: unknown): Promise<ServiceResult<FailedTest[]>> {
  const parsed = failedTestsInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const { programId } = parsed.data;

  const program = await prisma.program.findUnique({
    where: { id: programId },
    select: { id: true },
  });
  if (!program) {
    return notFound("PROGRAM", programId);
  }

  const failedTests = await prisma.testCase.findMany({
    where: { programId, outcome: "FAILED" },
    orderBy: { id: "asc" },
    take: MCP_LIMITS.maxRecords,
    select: {
      id: true,
      name: true,
      lastRunAt: true,
      requirements: { select: { requirementId: true } },
    },
  });

  const testCaseIds = failedTests.map((test) => test.id);
  // Only active defects — the tool contract is "related open defects";
  // RESOLVED and CLOSED defects are no longer open and must never appear
  // here (§4 of the correction pass, and get_requirement's separate
  // relatedDefects field is where a resolved/closed defect's history is
  // still visible).
  const defects =
    testCaseIds.length === 0
      ? []
      : await prisma.defect.findMany({
          where: {
            relatedTestCaseId: { in: testCaseIds },
            status: { in: ["OPEN", "IN_PROGRESS"] },
          },
          select: { id: true, severity: true, relatedTestCaseId: true },
        });

  const defectsByTestCaseId = new Map<string, Array<{ defectId: string; severity: string }>>();
  for (const defect of defects) {
    if (!defect.relatedTestCaseId) continue;
    const list = defectsByTestCaseId.get(defect.relatedTestCaseId) ?? [];
    list.push({ defectId: defect.id, severity: defect.severity });
    defectsByTestCaseId.set(defect.relatedTestCaseId, list);
  }

  return ok(
    failedTests.map((test) => ({
      testCaseId: test.id,
      name: boundMcpText(test.name),
      outcome: "FAILED" as const,
      lastRunAt: test.lastRunAt ? test.lastRunAt.toISOString() : null,
      requirementIds: test.requirements.map((link) => link.requirementId).sort(),
      relatedDefects: (defectsByTestCaseId.get(test.id) ?? []).sort((a, b) =>
        a.defectId.localeCompare(b.defectId),
      ),
    })),
  );
}
