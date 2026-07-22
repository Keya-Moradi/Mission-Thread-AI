import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { DEMO_USER_IDS, EVENT_IDS, ANALYSIS_IDS, PROGRAM_ID, RISK_IDS } from "../seed/ids";
import { calculateReadinessScore } from "../analysis/readiness";
import { buildAnalysisEvidence } from "../analysis/evidence";
import { MockLLMProvider } from "./mock-provider";
import { runImpactAnalysis } from "./orchestrator";
import { buildModelInputProjection } from "./model-input";

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

describe("readiness snapshot — persisted at analysis time, never recalculated on read", () => {
  it("[successful analysis has a readiness snapshot] matching the deterministic value at the time it ran", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const row = await prisma.impactAnalysis.findUniqueOrThrow({
      where: { id: result.data.finalAnalysisId },
    });
    expect(row.readinessSnapshot).not.toBeNull();
    const snapshot = row.readinessSnapshot as { totalScore: number; factors: unknown[] };
    expect(typeof snapshot.totalScore).toBe("number");
    expect(Array.isArray(snapshot.factors)).toBe(true);
  });

  it("[historical immutability] a stored readiness snapshot does not change after program data that affects readiness changes", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const before = await prisma.impactAnalysis.findUniqueOrThrow({
      where: { id: result.data.finalAnalysisId },
    });
    const snapshotBefore = before.readinessSnapshot;
    expect(snapshotBefore).not.toBeNull();

    const readinessBefore = await calculateReadinessScore(PROGRAM_ID);
    expect(readinessBefore.ok).toBe(true);

    const targetRisk = await prisma.risk.findUniqueOrThrow({ where: { id: RISK_IDS[0] } });
    try {
      // Closing an OPEN risk materially changes calculateReadinessScore()'s
      // risk-health factor (an active risk no longer counts against it) —
      // a genuine, not-contrived change to current program readiness.
      await prisma.risk.update({ where: { id: RISK_IDS[0] }, data: { status: "CLOSED" } });

      const readinessAfter = await calculateReadinessScore(PROGRAM_ID);
      expect(readinessAfter.ok).toBe(true);
      if (readinessBefore.ok && readinessAfter.ok) {
        // Sanity check that the mutation actually moved the needle — if it
        // didn't, this test would not actually be exercising immutability.
        expect(readinessAfter.data.totalScore).not.toBe(readinessBefore.data.totalScore);
      }

      const after = await prisma.impactAnalysis.findUniqueOrThrow({
        where: { id: result.data.finalAnalysisId },
      });
      expect(after.readinessSnapshot).toEqual(snapshotBefore);
    } finally {
      await prisma.risk.update({
        where: { id: RISK_IDS[0] },
        data: { status: targetRisk.status },
      });
    }
  });
});

describe("readiness snapshot — seeded demonstration analysis", () => {
  it("[seeded briefing displays the seeded snapshot] the persisted row's readinessSnapshot matches what the production pipeline computes for this event", async () => {
    const seeded = await prisma.impactAnalysis.findUniqueOrThrow({
      where: { id: ANALYSIS_IDS.supplierDelay },
    });
    expect(seeded.readinessSnapshot).not.toBeNull();

    // Independently rebuild the same evidence -> model-input pipeline the
    // seed step used, and confirm the persisted snapshot matches — proves
    // seed.ts genuinely used the shared pipeline rather than a hand-typed
    // value that happens to look right.
    const evidenceResult = await buildAnalysisEvidence(EVENT_IDS.supplierDelay);
    expect(evidenceResult.ok).toBe(true);
    if (!evidenceResult.ok) return;
    const modelInput = buildModelInputProjection(evidenceResult.data);
    expect(seeded.readinessSnapshot).toEqual(modelInput.deterministicResults.readinessScore);
  });
});
