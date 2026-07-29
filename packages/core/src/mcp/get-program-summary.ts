import { prisma } from "../db";
import { notFound, ok, validationError, type ServiceResult } from "../analysis/types";
import { calculateBudgetVariance } from "../analysis/budget";
import { calculateReadinessScore } from "../analysis/readiness";
import { programSummaryInputSchema } from "./schemas";
import type { ProgramSummary } from "./types";

export async function getProgramSummary(input: unknown): Promise<ServiceResult<ProgramSummary>> {
  const parsed = programSummaryInputSchema.safeParse(input);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((issue) => issue.message).join("; "));
  }
  const { programId } = parsed.data;

  const program = await prisma.program.findUnique({
    where: { id: programId },
    select: { id: true, name: true, description: true },
  });
  if (!program) {
    return notFound("PROGRAM", programId);
  }

  const [
    componentCount,
    requirementCount,
    milestones,
    riskCount,
    supplierCount,
    testCases,
    defectCount,
    budgetItemCount,
    eventCount,
    openRiskCount,
    budgetResult,
    readinessResult,
    mostRecentEvent,
    latestAttempt,
  ] = await Promise.all([
    prisma.component.count({ where: { programId } }),
    prisma.requirement.count({ where: { programId } }),
    prisma.milestone.findMany({ where: { programId }, select: { status: true } }),
    prisma.risk.count({ where: { programId } }),
    prisma.supplier.count({ where: { programId } }),
    prisma.testCase.findMany({ where: { programId }, select: { outcome: true } }),
    prisma.defect.count({ where: { programId } }),
    prisma.budgetItem.count({ where: { programId } }),
    prisma.programEvent.count({ where: { programId } }),
    prisma.risk.count({ where: { programId, status: { in: ["OPEN", "MITIGATING"] } } }),
    calculateBudgetVariance(programId),
    calculateReadinessScore(programId),
    prisma.programEvent.findFirst({
      where: { programId },
      orderBy: { createdAt: "desc" },
      select: { id: true, eventType: true, createdAt: true },
    }),
    prisma.impactAnalysis.findFirst({
      where: { programEvent: { programId } },
      orderBy: { createdAt: "desc" },
      select: { analysisRunId: true },
    }),
  ]);

  const milestoneStatusCounts: Record<string, number> = {};
  for (const milestone of milestones) {
    milestoneStatusCounts[milestone.status] = (milestoneStatusCounts[milestone.status] ?? 0) + 1;
  }

  const testOutcomeCounts: Record<string, number> = {};
  for (const testCase of testCases) {
    testOutcomeCounts[testCase.outcome] = (testOutcomeCounts[testCase.outcome] ?? 0) + 1;
  }

  let mostRecentAnalysisRun: ProgramSummary["mostRecentAnalysisRun"] = null;
  if (latestAttempt) {
    const terminal = await prisma.impactAnalysis.findFirst({
      where: { analysisRunId: latestAttempt.analysisRunId },
      orderBy: { attempt: "desc" },
      select: { analysisRunId: true, status: true, traceId: true, createdAt: true },
    });
    if (terminal) {
      mostRecentAnalysisRun = {
        analysisRunId: terminal.analysisRunId,
        terminalStatus: terminal.status,
        terminalTraceId: terminal.traceId,
        createdAt: terminal.createdAt.toISOString(),
      };
    }
  }

  return ok({
    programId: program.id,
    name: program.name,
    description: program.description,
    counts: {
      components: componentCount,
      requirements: requirementCount,
      milestones: milestones.length,
      risks: riskCount,
      suppliers: supplierCount,
      testCases: testCases.length,
      defects: defectCount,
      budgetItems: budgetItemCount,
      events: eventCount,
    },
    milestoneStatusCounts,
    testOutcomeCounts,
    openRiskCount,
    budgetVariance: budgetResult.ok
      ? {
          currency: budgetResult.data.currency,
          plannedTotal: budgetResult.data.plannedTotal,
          actualTotal: budgetResult.data.actualTotal,
          varianceAmount: budgetResult.data.varianceAmount,
          variancePercentage: budgetResult.data.variancePercentage,
        }
      : {
          currency: null,
          plannedTotal: null,
          actualTotal: null,
          varianceAmount: null,
          variancePercentage: null,
        },
    readinessScore: readinessResult.ok
      ? {
          totalScore: readinessResult.data.totalScore,
          warningCount: readinessResult.data.warnings.length,
        }
      : null,
    mostRecentEvent: mostRecentEvent
      ? {
          eventId: mostRecentEvent.id,
          eventType: mostRecentEvent.eventType,
          createdAt: mostRecentEvent.createdAt.toISOString(),
        }
      : null,
    mostRecentAnalysisRun,
  });
}
