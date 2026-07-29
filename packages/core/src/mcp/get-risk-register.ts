import { prisma } from "../db";
import { notFound, ok, validationError, type ServiceResult } from "../analysis/types";
import { computeRiskScore } from "../analysis/risk";
import { riskRegisterInputSchema } from "./schemas";
import { MCP_LIMITS } from "./types";
import type { RiskRegisterEntry } from "./types";

const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const STATUS_RANK: Record<string, number> = { OPEN: 0, MITIGATING: 0, CLOSED: 1 };

export async function getRiskRegister(input: unknown): Promise<ServiceResult<RiskRegisterEntry[]>> {
  const parsed = riskRegisterInputSchema.safeParse(input);
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

  const risks = await prisma.risk.findMany({
    where: { programId },
    select: {
      id: true,
      title: true,
      severity: true,
      probability: true,
      impact: true,
      status: true,
      componentId: true,
    },
  });

  const entries: RiskRegisterEntry[] = risks.map((risk) => ({
    riskId: risk.id,
    title: risk.title,
    severity: risk.severity,
    probability: risk.probability,
    impact: risk.impact,
    status: risk.status,
    componentId: risk.componentId,
    score: computeRiskScore(risk.probability, risk.impact, risk.severity).score,
  }));

  entries.sort((a, b) => {
    const statusDelta = (STATUS_RANK[a.status] ?? 1) - (STATUS_RANK[b.status] ?? 1);
    if (statusDelta !== 0) return statusDelta;
    const severityDelta = (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4);
    if (severityDelta !== 0) return severityDelta;
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    return a.riskId.localeCompare(b.riskId);
  });

  return ok(entries.slice(0, MCP_LIMITS.maxRecords));
}
