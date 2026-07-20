import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { DEMO_USER_IDS, EVENT_IDS } from "../seed/ids";
import { AiConfigurationError, AiProviderError } from "./errors";
import { generateMockImpactAnalysis, MockLLMProvider } from "./mock-provider";
import { runImpactAnalysis } from "./orchestrator";
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from "./provider";

type ScriptStep = "valid" | "invalid" | "throw-transient" | "throw-config";

/**
 * A fully controlled, no-network test provider that plays back a fixed
 * script of outcomes across successive calls (one per attempt) — lets the
 * orchestrator's retry/failure/success paths be exercised deterministically
 * without ever depending on a real provider or the mock's own "always
 * succeeds" behavior.
 */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  callCount = 0;
  requests: LLMProviderRequest[] = [];

  constructor(private readonly script: ScriptStep[]) {}

  async generateImpactAnalysis(request: LLMProviderRequest): Promise<LLMProviderResponse> {
    this.requests.push(request);
    const step = this.script[this.callCount] ?? "valid";
    this.callCount += 1;

    if (step === "throw-transient") {
      throw new AiProviderError("scripted transient failure", "TRANSIENT_PROVIDER_FAILURE");
    }
    if (step === "throw-config") {
      throw new AiConfigurationError("scripted configuration failure");
    }
    if (step === "invalid") {
      return {
        provider: this.name,
        model: "scripted-model",
        rawOutput: { not: "valid" },
        durationMs: 1,
      };
    }
    return {
      provider: this.name,
      model: "scripted-model",
      rawOutput: generateMockImpactAnalysis(request.modelInput),
      durationMs: 1,
    };
  }
}

class ThrowingProvider implements LLMProvider {
  readonly name = "throwing";
  async generateImpactAnalysis(): Promise<LLMProviderResponse> {
    throw new Error(
      "SECRET_CONNECTION_STRING=postgres://leaked:pw@host/db must never be persisted",
    );
  }
}

const createdAnalysisRunIds: string[] = [];
const createdUserIds: string[] = [];

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
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

describe("runImpactAnalysis — authorization", () => {
  it("[Program Manager succeeds] the seeded PM can run an analysis", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      createdAnalysisRunIds.push(result.data.analysisRunId);
      expect(result.data.status).toBe("SUCCEEDED");
    }
  });

  it("[Engineering Lead is forbidden]", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.engineeringLead, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[Executive Viewer is forbidden]", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.executiveViewer, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[missing actor] an actor ID that never existed is FORBIDDEN", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, "USER-DOES-NOT-EXIST", {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[stale/deleted actor] an actor ID that existed but was deleted is FORBIDDEN", async () => {
    const tempUserId = `USER-TEST-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: tempUserId,
        email: `${tempUserId}@example.test`,
        name: "Temp PM (deleted before use)",
        role: "PROGRAM_MANAGER",
        passwordHash: "unused",
      },
    });
    await prisma.user.delete({ where: { id: tempUserId } });

    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, tempUserId, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[missing event] an event ID that doesn't exist is NOT_FOUND", async () => {
    const result = await runImpactAnalysis("EVT-DOES-NOT-EXIST", DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("runImpactAnalysis — attempt lifecycle", () => {
  it("[attempt 1 succeeds] creates exactly one ImpactAnalysis row with exactly 3 mitigation options, exactly 1 recommended", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.attempts).toBe(1);

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
      include: { mitigationOptions: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("SUCCEEDED");
    expect(rows[0]?.mitigationOptions).toHaveLength(3);
    expect(rows[0]?.mitigationOptions.filter((o) => o.isRecommended)).toHaveLength(1);
  });

  it("[attempt 1 invalid, attempt 2 succeeds] shares one analysisRunId, distinct traceIds, passes validationFeedback to the retry", async () => {
    const provider = new ScriptedProvider(["invalid", "valid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("SUCCEEDED");
    expect(result.data.attempts).toBe(2);

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
      orderBy: { attempt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("FAILED");
    expect(rows[0]?.errorCategory).toBe("INVALID_OUTPUT_SCHEMA");
    expect(rows[1]?.status).toBe("SUCCEEDED");
    expect(rows[0]?.traceId).not.toBe(rows[1]?.traceId);
    expect(rows.every((r) => r.analysisRunId === result.data.analysisRunId)).toBe(true);

    expect(provider.requests[0]?.validationFeedback).toBeUndefined();
    expect(provider.requests[1]?.validationFeedback).toBeDefined();
    expect(provider.requests[1]?.validationFeedback?.length ?? 0).toBeGreaterThan(0);
  });

  it("[two invalid attempts] final status FAILED, zero mitigation options created", async () => {
    const provider = new ScriptedProvider(["invalid", "invalid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("FAILED");
    expect(result.data.attempts).toBe(2);

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "FAILED")).toBe(true);

    const optionCount = await prisma.mitigationOption.count({
      where: { impactAnalysisId: { in: rows.map((r) => r.id) } },
    });
    expect(optionCount).toBe(0);
  });

  it("[independent re-analysis] a second call gets a new analysisRunId, not the same one", async () => {
    const first = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    const second = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    createdAnalysisRunIds.push(first.data.analysisRunId, second.data.analysisRunId);
    expect(first.data.analysisRunId).not.toBe(second.data.analysisRunId);
  });

  it("[configuration failure is never retried] exactly one attempt, category CONFIGURATION_ERROR", async () => {
    const provider = new ScriptedProvider(["throw-config", "valid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("FAILED");
    expect(result.data.attempts).toBe(1);
    expect(result.data.errorCategory).toBe("CONFIGURATION_ERROR");
    expect(provider.callCount).toBe(1);
  });

  it("[correct audit actions] a successful run creates ANALYSIS_STARTED then ANALYSIS_SUCCEEDED", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const auditEvents = await prisma.auditEvent.findMany({
      where: { targetRecordId: result.data.finalAnalysisId },
      orderBy: { createdAt: "asc" },
    });
    expect(auditEvents.map((e) => e.action)).toEqual(["ANALYSIS_STARTED", "ANALYSIS_SUCCEEDED"]);
    expect(auditEvents.every((e) => e.traceId === result.data.finalTraceId)).toBe(true);
  });

  it("[source references are allowlisted and deduplicated] no duplicate (recordType, recordId) pair", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const refs = await prisma.sourceReference.findMany({
      where: { impactAnalysisId: result.data.finalAnalysisId },
    });
    const pairs = refs.map((r) => `${r.recordType}:${r.recordId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(refs.length).toBeGreaterThan(0);
  });

  it("[safe error persistence] a thrown provider error never leaks its message into persisted fields", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new ThrowingProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("FAILED");
    // TRANSIENT_PROVIDER_FAILURE is retryable, so this exercises both attempts.
    expect(result.data.attempts).toBe(2);

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
    });
    for (const row of rows) {
      expect(row.errorCategory).toBe("TRANSIENT_PROVIDER_FAILURE");
      expect(JSON.stringify(row.validationErrors ?? "")).not.toContain("SECRET_CONNECTION_STRING");
      expect(row.errorCategory).not.toContain("SECRET");
    }
  });
});
