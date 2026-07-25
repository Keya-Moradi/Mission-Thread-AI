import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { prisma } from "../db";
import { DEMO_USER_IDS, EVENT_IDS } from "../seed/ids";
import { OpenAiImpactAnalysisProvider } from "./openai-provider";
import { runImpactAnalysis } from "./orchestrator";

// Phase 6 correction pass: exercises the REAL OpenAiImpactAnalysisProvider
// class (with a fake `responses.create`, never a real network call) through
// the REAL runImpactAnalysis() orchestrator, proving the two together
// actually bound provider spend and never leak a giant/adversarial
// provider-controlled value into a retry request, persisted state, or logs.
// See docs/DECISIONS.md, "Phase 6 correction: provider-spend and
// output-bounds".

function buildValidMockOption(sourceRecordId: string) {
  return {
    title: "Option",
    description: "Description.",
    tradeoffs: "Tradeoffs.",
    costImpact: null,
    scheduleImpact: null,
    isRecommended: false,
    sourceRecordIds: [sourceRecordId],
  };
}

const createdAnalysisRunIds: string[] = [];
async function cleanupAnalysisRun(analysisRunId: string) {
  const analyses = await prisma.impactAnalysis.findMany({
    where: { analysisRunId },
    select: { id: true },
  });
  const ids = analyses.map((a) => a.id);
  if (ids.length === 0) return;
  await prisma.auditEvent.deleteMany({ where: { targetRecordId: { in: ids } } });
  await prisma.sourceReference.deleteMany({ where: { impactAnalysisId: { in: ids } } });
  await prisma.mitigationOption.deleteMany({ where: { impactAnalysisId: { in: ids } } });
  await prisma.impactAnalysis.deleteMany({ where: { id: { in: ids } } });
}

afterEach(async () => {
  for (const runId of createdAnalysisRunIds) {
    await cleanupAnalysisRun(runId);
  }
  createdAnalysisRunIds.length = 0;
});

describe("runImpactAnalysis + OpenAiImpactAnalysisProvider — provider-spend cap", () => {
  it("[two transient failures] results in at most two total responses.create() calls, never more", async () => {
    let callCount = 0;
    const client = {
      responses: {
        create: async () => {
          callCount += 1;
          throw new Error("simulated transient failure");
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("FAILED");
    expect(result.data.attempts).toBe(2);
    expect(callCount).toBe(2);
  });

  it("[giant fabricated ID never reaches the retry request, persisted errors, or logs] a semantically/structurally invalid first attempt carrying a giant canary value is rejected and fully redacted before the retry", async () => {
    const GIANT_CANARY = "GIANT-CANARY-" + "B".repeat(5000);
    const requests: Record<string, unknown>[] = [];
    const client = {
      responses: {
        create: async (params: Record<string, unknown>) => {
          requests.push(params);
          return {
            model: "gpt-test",
            output_text: JSON.stringify({
              executiveSummary: "Summary.",
              missionImpact: "Impact.",
              scheduleExposureDays: null,
              budgetExposureAmount: null,
              affectedRequirementIds: [],
              affectedMilestoneIds: [],
              verificationGaps: [],
              assumptions: [],
              unknowns: [],
              confidence: "MEDIUM",
              // Exceeds OUTPUT_LIMITS.maxRecordIdLength (128) — a
              // structural (not merely semantic) rejection, exercising the
              // per-string output bound directly through the live-provider
              // adapter's own real JSON parse -> Zod path.
              sourceRecordIds: [GIANT_CANARY],
              mitigationOptions: [
                { ...buildValidMockOption("EVT-SUPPLIER-001"), isRecommended: true },
                buildValidMockOption("EVT-SUPPLIER-001"),
                buildValidMockOption("EVT-SUPPLIER-001"),
              ],
            }),
          };
        },
      },
    } as unknown as OpenAI;
    const provider = new OpenAiImpactAnalysisProvider({
      apiKey: "sk-test",
      model: "gpt-test",
      client,
    });

    const loggedLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      loggedLines.push(String(line));
    });

    let result;
    try {
      result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
        provider,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("FAILED");
    expect(result.data.attempts).toBe(2);

    // Both real HTTP-shaped calls happened (retryable structural failure,
    // retried exactly once) — the second request is where a naive
    // implementation would have leaked the canary back via
    // validationFeedback.
    expect(requests).toHaveLength(2);
    const secondRequestInput = requests[1]?.input as string;
    expect(secondRequestInput).not.toContain(GIANT_CANARY);
    expect(secondRequestInput).not.toContain("GIANT-CANARY");

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.stringify(row.validationErrors)).not.toContain(GIANT_CANARY);
      expect(JSON.stringify(row.validationErrors)).not.toContain("GIANT-CANARY");
    }

    for (const line of loggedLines) {
      expect(line).not.toContain(GIANT_CANARY);
      expect(line).not.toContain("GIANT-CANARY");
    }
  });
});
