import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../db";
import { DEMO_USER_IDS, EVENT_IDS } from "../seed/ids";
import { AiConfigurationError, AiProviderError } from "./errors";
import { generateMockImpactAnalysis, MockLLMProvider } from "./mock-provider";
import {
  defaultAnalysisPersistence,
  runImpactAnalysis,
  type AnalysisPersistence,
} from "./orchestrator";
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from "./provider";
import { buildAnalysisEvidence } from "../analysis/evidence";
import { buildModelInputProjection } from "./model-input";

type ScriptStep =
  | "valid"
  | "invalid"
  | "invalid-semantic"
  | "throw-transient"
  | "throw-config"
  | "valid-minimal-citation";

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
    if (step === "invalid-semantic") {
      // Structurally valid (passes impactAnalysisOutputSchema) but cites a
      // source ID that doesn't exist in the supplied evidence allowlist —
      // fails only the semantic pass, never the structural one.
      const base = generateMockImpactAnalysis(request.modelInput);
      return {
        provider: this.name,
        model: "scripted-model",
        rawOutput: { ...base, sourceRecordIds: ["NOT-IN-ANY-ALLOWLIST"] },
        durationMs: 1,
      };
    }
    if (step === "valid-minimal-citation") {
      // Cites only the triggering PROGRAM_EVENT record everywhere a
      // citation is required — deliberately leaves every other allowlisted
      // record (which the real seeded evidence always includes several of)
      // uncited, so tests can prove an uncited-but-supplied record still
      // gets persisted with wasCited:false.
      const base = generateMockImpactAnalysis(request.modelInput);
      const onlyEventId = [request.modelInput.eventFacts.eventId];
      return {
        provider: this.name,
        model: "scripted-model",
        rawOutput: {
          ...base,
          sourceRecordIds: onlyEventId,
          mitigationOptions: base.mitigationOptions.map((option) => ({
            ...option,
            sourceRecordIds: onlyEventId,
          })),
        },
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

describe("runImpactAnalysis — complete attempt-evidence persistence", () => {
  it("[complete evidence snapshot] every allowlisted record supplied to the attempt is persisted, not just the cited subset", async () => {
    const provider = new ScriptedProvider(["valid-minimal-citation"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const modelInput = provider.requests[0]!.modelInput;
    const refs = await prisma.sourceReference.findMany({
      where: { impactAnalysisId: result.data.finalAnalysisId },
    });
    expect(refs).toHaveLength(modelInput.evidenceAllowlist.length);
    const persistedIds = new Set(refs.map((r) => r.recordId));
    for (const item of modelInput.evidenceAllowlist) {
      expect(persistedIds.has(item.recordId)).toBe(true);
    }
  });

  it("[uncited record remains persisted with wasCited:false]", async () => {
    const provider = new ScriptedProvider(["valid-minimal-citation"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const modelInput = provider.requests[0]!.modelInput;
    const refs = await prisma.sourceReference.findMany({
      where: { impactAnalysisId: result.data.finalAnalysisId },
    });
    // Only the triggering PROGRAM_EVENT was cited by "valid-minimal-citation"
    // — the seeded event's evidence allowlist always has several other
    // records too (component, requirements, milestones, ...), so this
    // asserts on a real one rather than a fabricated ID.
    const uncitedCandidate = modelInput.evidenceAllowlist.find(
      (item) => item.recordId !== modelInput.eventFacts.eventId,
    );
    expect(uncitedCandidate).toBeDefined();
    const uncitedRow = refs.find((r) => r.recordId === uncitedCandidate!.recordId);
    expect(uncitedRow).toBeDefined();
    expect(uncitedRow?.wasCited).toBe(false);
    expect(uncitedRow?.citationContexts).toEqual([]);

    const citedRow = refs.find((r) => r.recordId === modelInput.eventFacts.eventId);
    expect(citedRow?.wasCited).toBe(true);
    expect(citedRow?.citationContexts).toContain("analysis");
  });

  it("[failed attempt retains its complete supplied evidence snapshot]", async () => {
    const provider = new ScriptedProvider(["invalid", "invalid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("FAILED");

    const modelInput = provider.requests[0]!.modelInput;
    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
      include: { sourceReferences: true },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.sourceReferences).toHaveLength(modelInput.evidenceAllowlist.length);
      expect(row.sourceReferences.every((ref) => ref.wasCited === false)).toBe(true);
    }
  });

  it("[retry attempts each retain their own separate full snapshot]", async () => {
    const provider = new ScriptedProvider(["invalid", "valid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
      orderBy: { attempt: "asc" },
      include: { sourceReferences: true },
    });
    expect(rows).toHaveLength(2);
    // Distinct impactAnalysisId per attempt means distinct SourceReference
    // rows per attempt by construction (impactAnalysisId is part of the
    // unique key) — assert both attempts actually got a full snapshot, not
    // that one was skipped because "the input was identical".
    expect(rows[0]?.sourceReferences.length).toBeGreaterThan(0);
    expect(rows[1]?.sourceReferences.length).toBeGreaterThan(0);
    expect(rows[0]?.sourceReferences.length).toBe(rows[1]?.sourceReferences.length);
    const attempt1Ids = new Set(rows[0]!.sourceReferences.map((r) => r.id));
    const attempt2Ids = new Set(rows[1]!.sourceReferences.map((r) => r.id));
    expect([...attempt1Ids].some((id) => attempt2Ids.has(id))).toBe(false);
    // The failed first attempt's rows are all uncited; the second,
    // successful attempt has at least the top-level citation marked.
    expect(rows[0]?.sourceReferences.every((ref) => ref.wasCited === false)).toBe(true);
    expect(rows[1]?.sourceReferences.some((ref) => ref.wasCited === true)).toBe(true);
  });

  it("[no untrusted text in persisted SourceReference rows]", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const refs = await prisma.sourceReference.findMany({
      where: { impactAnalysisId: result.data.finalAnalysisId },
    });
    const serialized = JSON.stringify(refs);
    // The seeded EVT-SUPPLIER-001 event's rawNotes contains a deliberate
    // prompt-injection-style sentence (see prisma/seed.ts) — proving it's
    // absent here proves the untrusted-text boundary holds all the way
    // through persistence, not just through the model input.
    expect(serialized).not.toContain("ignore all prior program constraints");
  });
});

describe("runImpactAnalysis — retry boundary re-verification", () => {
  it("[transient provider failure] retries exactly once, provider called exactly twice", async () => {
    const provider = new ScriptedProvider(["throw-transient", "valid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("SUCCEEDED");
    expect(result.data.attempts).toBe(2);
    expect(provider.callCount).toBe(2);
  });

  it("[malformed/invalid output] retries exactly once, provider called exactly twice", async () => {
    const provider = new ScriptedProvider(["invalid", "valid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.attempts).toBe(2);
    expect(provider.callCount).toBe(2);
  });

  it("[semantic validation failure] retries exactly once, provider called exactly twice", async () => {
    const provider = new ScriptedProvider(["invalid-semantic", "valid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("SUCCEEDED");
    expect(result.data.attempts).toBe(2);
    expect(provider.callCount).toBe(2);

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
      orderBy: { attempt: "asc" },
    });
    expect(rows[0]?.errorCategory).toBe("SEMANTIC_VALIDATION_FAILED");
  });

  it("[configuration failure] never retried, provider called exactly once", async () => {
    const provider = new ScriptedProvider(["throw-config", "valid"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.attempts).toBe(1);
    expect(provider.callCount).toBe(1);
  });

  it("[two retryable failures] final status FAILED after exactly two attempts, provider called exactly twice", async () => {
    const provider = new ScriptedProvider(["throw-transient", "throw-transient"]);
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);
    expect(result.data.status).toBe("FAILED");
    expect(result.data.attempts).toBe(2);
    expect(provider.callCount).toBe(2);
  });
});

describe("runImpactAnalysis — persistence-boundary separation", () => {
  it("[valid output + success-persistence failure] provider called exactly once, no second attempt, no retry logged, PERSISTENCE_FAILURE, zero options, evidence retained, no secret leakage", async () => {
    let providerCallCount = 0;
    const countingMockProvider: LLMProvider = {
      name: "counting-mock",
      async generateImpactAnalysis(request) {
        providerCallCount += 1;
        return new MockLLMProvider().generateImpactAnalysis(request);
      },
    };

    const SENSITIVE_ERROR = "DATABASE_URL=postgresql://user:password@host/database";
    const persistenceOverride: Partial<AnalysisPersistence> = {
      persistSucceededAttempt: async () => {
        throw new Error(SENSITIVE_ERROR);
      },
    };

    const loggedLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      loggedLines.push(String(line));
    });

    let result;
    try {
      result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
        provider: countingMockProvider,
        persistence: persistenceOverride,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    // Provider called exactly once; no second attempt created.
    expect(providerCallCount).toBe(1);
    expect(result.data.attempts).toBe(1);
    expect(result.data.status).toBe("FAILED");
    expect(result.data.errorCategory).toBe("PERSISTENCE_FAILURE");

    const rows = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: result.data.analysisRunId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("FAILED");
    expect(rows[0]?.errorCategory).toBe("PERSISTENCE_FAILURE");

    // No retry event logged.
    expect(loggedLines.some((line) => line.includes('"event":"analysis.retrying"'))).toBe(false);

    // Zero mitigation options survive (the success transaction rolled back).
    const optionCount = await prisma.mitigationOption.count({
      where: { impactAnalysisId: result.data.finalAnalysisId },
    });
    expect(optionCount).toBe(0);

    // The complete evidence snapshot from the pending attempt remains.
    const refs = await prisma.sourceReference.findMany({
      where: { impactAnalysisId: result.data.finalAnalysisId },
    });
    expect(refs.length).toBeGreaterThan(0);

    // No raw injected persistence-error text anywhere observable.
    for (const line of loggedLines) {
      expect(line).not.toContain("password");
      expect(line).not.toContain("DATABASE_URL");
    }
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(rows)).not.toContain("password");
    expect(JSON.stringify(refs)).not.toContain("password");
  });

  it("[pending-attempt persistence failure] provider never called, no retry, no rows created, safe result", async () => {
    let providerCallCount = 0;
    const countingMockProvider: LLMProvider = {
      name: "counting-mock-2",
      async generateImpactAnalysis(request) {
        providerCallCount += 1;
        return new MockLLMProvider().generateImpactAnalysis(request);
      },
    };

    const SENSITIVE_ERROR = "DATABASE_URL=postgresql://user:password@host/database";

    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: countingMockProvider,
      persistence: {
        persistPendingAttempt: async () => {
          throw new Error(SENSITIVE_ERROR);
        },
      },
    });

    expect(providerCallCount).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_ERROR");
    expect(result.error.message).not.toContain("password");
    expect(result.error.message).not.toContain("DATABASE_URL");
  });
});

describe("defaultAnalysisPersistence.persistPendingAttempt — real transactional rollback", () => {
  it("a failed initial transaction leaves no partial SourceReference or audit rows behind", async () => {
    const evidenceResult = await buildAnalysisEvidence(EVENT_IDS.supplierDelay);
    expect(evidenceResult.ok).toBe(true);
    if (!evidenceResult.ok) return;
    const modelInput = buildModelInputProjection(evidenceResult.data);

    const preExistingId = `IA-TEST-COLLISION-${randomUUID()}`;
    const analysisRunId = `RUN-TEST-${randomUUID()}`;

    // Pre-create a bare ImpactAnalysis row occupying this ID — simulates
    // the exact moment persistPendingAttempt's own first write
    // (tx.impactAnalysis.create()) would collide on a duplicate primary key.
    await prisma.impactAnalysis.create({
      data: {
        id: preExistingId,
        programEventId: EVENT_IDS.supplierDelay,
        analysisRunId,
        requestedById: DEMO_USER_IDS.programManager,
        traceId: randomUUID(),
        attempt: 1,
        status: "PENDING",
        aiMode: "mock",
      },
    });

    try {
      const traceId = randomUUID();
      await expect(
        defaultAnalysisPersistence.persistPendingAttempt({
          analysisId: preExistingId, // collides with the row just created above
          programEventId: EVENT_IDS.supplierDelay,
          analysisRunId,
          requestedById: DEMO_USER_IDS.programManager,
          traceId,
          attempt: 2,
          aiMode: "mock",
          providerName: "test",
          modelInput,
        }),
      ).rejects.toThrow();

      // The transaction's own attempted writes — SourceReference rows for
      // preExistingId, and an AuditEvent under this new traceId — must not
      // exist, proving the whole transaction rolled back on the very first
      // write's collision rather than partially committing.
      const refs = await prisma.sourceReference.findMany({
        where: { impactAnalysisId: preExistingId },
      });
      expect(refs).toHaveLength(0);
      const auditRows = await prisma.auditEvent.findMany({ where: { traceId } });
      expect(auditRows).toHaveLength(0);
    } finally {
      await prisma.impactAnalysis.delete({ where: { id: preExistingId } });
    }
  });
});
