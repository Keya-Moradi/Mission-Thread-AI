import { prisma } from "../db";
import { entityIdArraySchema, formatZodError } from "./schemas";
import { ok, validationError, type ServiceResult } from "./types";

export type VerificationGapCategory = "NO_COVERAGE" | "FAILED" | "BLOCKED" | "NOT_RUN" | "NONE";

export interface VerificationGapResult {
  requirementId: string;
  testIds: string[];
  outcomes: Array<{ testId: string; outcome: string }>;
  gapCategory: VerificationGapCategory;
  summary: string;
}

export interface VerificationGapsResponse {
  results: VerificationGapResult[];
  /** Requested requirement IDs that don't exist in the database. */
  missingRequirementIds: string[];
}

/**
 * Worst-outcome-wins priority, matching the order the spec lists gap kinds
 * in: a requirement with even one FAILED test is reported as FAILED, even
 * if it also has a PASSED test — a partial pass does not clear a failure.
 */
const GAP_PRIORITY: Record<string, number> = { FAILED: 0, BLOCKED: 1, NOT_RUN: 2 };

export function classifyGap(outcomes: string[]): VerificationGapCategory {
  if (outcomes.length === 0) return "NO_COVERAGE";
  const worst = outcomes
    .filter((outcome) => outcome in GAP_PRIORITY)
    .sort((a, b) => GAP_PRIORITY[a]! - GAP_PRIORITY[b]!)[0];
  return (worst as VerificationGapCategory | undefined) ?? "NONE";
}

export async function getVerificationGaps(
  requirementIds: string[],
): Promise<ServiceResult<VerificationGapsResponse>> {
  const parsed = entityIdArraySchema.safeParse(requirementIds);
  if (!parsed.success) {
    return validationError(formatZodError(parsed.error));
  }
  if (parsed.data.length === 0) {
    return ok({ results: [], missingRequirementIds: [] });
  }

  const [foundRequirements, testLinks] = await Promise.all([
    prisma.requirement.findMany({
      where: { id: { in: parsed.data } },
      select: { id: true },
    }),
    prisma.testRequirement.findMany({
      where: { requirementId: { in: parsed.data } },
      select: {
        requirementId: true,
        testCase: { select: { id: true, outcome: true } },
      },
    }),
  ]);

  const foundIds = new Set(foundRequirements.map((r) => r.id));
  const missingRequirementIds = parsed.data.filter((id) => !foundIds.has(id)).sort();

  const testsByRequirement = new Map<string, Array<{ testId: string; outcome: string }>>();
  for (const link of testLinks) {
    const entry = testsByRequirement.get(link.requirementId) ?? [];
    // Deduplicate repeated test relationships — TestRequirement's composite
    // key already prevents an identical row from existing, but this result
    // shouldn't rely solely on that DB constraint to guarantee its own
    // invariant.
    if (!entry.some((existing) => existing.testId === link.testCase.id)) {
      entry.push({ testId: link.testCase.id, outcome: link.testCase.outcome });
    }
    testsByRequirement.set(link.requirementId, entry);
  }

  const results: VerificationGapResult[] = [...foundIds].sort().map((requirementId) => {
    const tests = (testsByRequirement.get(requirementId) ?? []).sort((a, b) =>
      a.testId.localeCompare(b.testId),
    );
    const gapCategory = classifyGap(tests.map((t) => t.outcome));
    return {
      requirementId,
      testIds: tests.map((t) => t.testId),
      outcomes: tests,
      gapCategory,
      summary:
        gapCategory === "NONE"
          ? `Requirement "${requirementId}" is fully verified (${tests.length} passing test${tests.length === 1 ? "" : "s"}).`
          : gapCategory === "NO_COVERAGE"
            ? `Requirement "${requirementId}" has no associated tests.`
            : `Requirement "${requirementId}" has a verification gap: ${gapCategory} (${tests.length} associated test${tests.length === 1 ? "" : "s"}).`,
    };
  });

  return ok({ results, missingRequirementIds });
}
