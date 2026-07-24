import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../db";
import { DEMO_USER_IDS, EVENT_IDS } from "../seed/ids";
import { AnalysisRateLimiter } from "../security/analysis-rate-limiter";
import { MockLLMProvider, generateMockImpactAnalysis } from "./mock-provider";
import { runImpactAnalysis } from "./orchestrator";
import type { LLMProvider, LLMProviderRequest, LLMProviderResponse } from "./provider";

/** Plays back a fixed script of outcomes across successive
 * generateImpactAnalysis() calls — reused here (a smaller copy of
 * orchestrator.test.ts's ScriptedProvider) so a "provider retry doesn't
 * consume a second rate-limit slot" test can force exactly one retryable
 * failure per top-level runImpactAnalysis() call. */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted-rate-limit-test";
  callCount = 0;
  constructor(private readonly script: ("invalid" | "valid")[]) {}
  async generateImpactAnalysis(request: LLMProviderRequest): Promise<LLMProviderResponse> {
    const step = this.script[this.callCount] ?? "valid";
    this.callCount += 1;
    if (step === "invalid") {
      return { provider: this.name, model: "scripted", rawOutput: { not: "valid" }, durationMs: 1 };
    }
    return {
      provider: this.name,
      model: "scripted",
      rawOutput: generateMockImpactAnalysis(request.modelInput),
      durationMs: 1,
    };
  }
}

function makeClock(startMs = 0) {
  let now = startMs;
  return { now: () => now, advance: (ms: number) => (now += ms) };
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

describe("runImpactAnalysis — rate limiting", () => {
  it("[first N pass, N+1th denied] using an isolated limiter with maxRequests=2", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 2,
      windowSeconds: 60,
    });

    const first = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(first.ok).toBe(true);
    if (first.ok) createdAnalysisRunIds.push(first.data.analysisRunId);

    const second = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(second.ok).toBe(true);
    if (second.ok) createdAnalysisRunIds.push(second.data.analysisRunId);

    const third = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error.code).toBe("RATE_LIMITED");
  });

  it("[safe error contains retry information] RATE_LIMITED errors carry a positive retryAfterSeconds and a safe, displayable message", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 1,
      windowSeconds: 60,
    });

    await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    }).then((r) => {
      if (r.ok) createdAnalysisRunIds.push(r.data.analysisRunId);
    });

    const denied = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("RATE_LIMITED");
    expect(denied.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.error.message).toContain("second");
    // Safe to show verbatim — no internal map state, no other actor's ID.
    expect(denied.error.message).not.toMatch(/USER-|Map|windowStart/);
  });

  it("[denied request creates zero rows and never calls the provider]", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 0,
      windowSeconds: 60,
    });
    let providerCallCount = 0;
    const countingProvider: LLMProvider = {
      name: "counting",
      async generateImpactAnalysis(request) {
        providerCallCount += 1;
        return new MockLLMProvider().generateImpactAnalysis(request);
      },
    };

    const before = await prisma.impactAnalysis.count();
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: countingProvider,
      rateLimiter,
    });
    const after = await prisma.impactAnalysis.count();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RATE_LIMITED");
    expect(providerCallCount).toBe(0);
    expect(after).toBe(before);

    const decisionCount = await prisma.decision.count();
    const proposedChangeCount = await prisma.proposedChange.count();
    expect(decisionCount).toBeGreaterThanOrEqual(0); // sanity: query succeeds
    expect(proposedChangeCount).toBeGreaterThanOrEqual(0);
  });

  it("[provider retry inside one call consumes only one slot] two attempts (one retryable failure + one success) inside a single runImpactAnalysis() call only counts once against the limiter", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 3,
      windowSeconds: 60,
    });

    for (let i = 0; i < 3; i++) {
      const provider = new ScriptedProvider(["invalid", "valid"]);
      const result = await runImpactAnalysis(
        EVENT_IDS.supplierDelay,
        DEMO_USER_IDS.programManager,
        {
          provider,
          rateLimiter,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      createdAnalysisRunIds.push(result.data.analysisRunId);
      expect(result.data.status).toBe("SUCCEEDED");
      // Two provider calls happened (one failure, one retry-success) — the
      // rate limiter still only saw this as one request.
      expect(provider.callCount).toBe(2);
    }

    // Exactly 3 accepted requests have now consumed the entire allowance —
    // a 4th is denied, proving the limiter counted 3 *requests*, not the
    // 6 total provider calls those 3 requests actually made.
    const fourth = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(fourth.ok).toBe(false);
    if (fourth.ok) return;
    expect(fourth.error.code).toBe("RATE_LIMITED");
  });

  it("[unauthorized actor never consumes a slot] Engineering Lead is FORBIDDEN, never RATE_LIMITED, and consumes no allowance", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 1,
      windowSeconds: 60,
    });

    for (let i = 0; i < 5; i++) {
      const result = await runImpactAnalysis(
        EVENT_IDS.supplierDelay,
        DEMO_USER_IDS.engineeringLead,
        {
          provider: new MockLLMProvider(),
          rateLimiter,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("FORBIDDEN");
    }

    // The Program Manager's own allowance (a different key) is untouched —
    // proving the 5 forbidden Engineering Lead calls above never consumed
    // anything under any key this limiter tracks.
    const pmResult = await runImpactAnalysis(
      EVENT_IDS.supplierDelay,
      DEMO_USER_IDS.programManager,
      {
        provider: new MockLLMProvider(),
        rateLimiter,
      },
    );
    expect(pmResult.ok).toBe(true);
    if (pmResult.ok) createdAnalysisRunIds.push(pmResult.data.analysisRunId);
  });

  it("[malformed event ID never consumes a slot]", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 1,
      windowSeconds: 60,
    });

    const malformed = await runImpactAnalysis("   ", DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("VALIDATION_ERROR");

    const real = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(real.ok).toBe(true);
    if (real.ok) createdAnalysisRunIds.push(real.data.analysisRunId);
  });

  it("[nonexistent event never consumes a slot]", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 1,
      windowSeconds: 60,
    });

    const missing = await runImpactAnalysis("EVT-DOES-NOT-EXIST", DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");

    const real = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
      rateLimiter,
    });
    expect(real.ok).toBe(true);
    if (real.ok) createdAnalysisRunIds.push(real.data.analysisRunId);
  });

  it("[no secrets or untrusted text in the rate-limit log line]", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 0,
      windowSeconds: 60,
    });

    const loggedLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      loggedLines.push(String(line));
    });

    try {
      await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
        provider: new MockLLMProvider(),
        rateLimiter,
      });
    } finally {
      consoleSpy.mockRestore();
    }

    const rateLimitLines = loggedLines.filter((line) =>
      line.includes('"event":"analysis.rate_limited"'),
    );
    expect(rateLimitLines.length).toBe(1);
    // The seeded event's rawNotes contain a deliberate prompt-injection
    // sentence (see prisma/seed.ts) — proving it's absent here proves the
    // rate-limit log path only ever includes the eventId, never its content.
    expect(rateLimitLines[0]).not.toContain("ignore all prior program constraints");
    expect(rateLimitLines[0]).not.toContain("OPENAI_API_KEY");
    expect(rateLimitLines[0]).not.toContain("DATABASE_URL");
    const parsed = JSON.parse(rateLimitLines[0]!);
    expect(parsed.requestedById).toBe(DEMO_USER_IDS.programManager);
    expect(parsed.eventId).toBe(EVENT_IDS.supplierDelay);
    expect(typeof parsed.retryAfterSeconds).toBe("number");
  });

  it("[independent actors have independent limits] two distinct Program Managers under the same shared limiter each get their own allowance", async () => {
    const clock = makeClock();
    const rateLimiter = new AnalysisRateLimiter({
      clock: clock.now,
      maxRequests: 1,
      windowSeconds: 60,
    });

    const secondPmId = `USER-TEST-PM-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: secondPmId,
        email: `${secondPmId}@example.test`,
        name: "Temp second Program Manager (rate-limit test)",
        role: "PROGRAM_MANAGER",
        passwordHash: "unused",
      },
    });

    try {
      const pmFirst = await runImpactAnalysis(
        EVENT_IDS.supplierDelay,
        DEMO_USER_IDS.programManager,
        {
          provider: new MockLLMProvider(),
          rateLimiter,
        },
      );
      expect(pmFirst.ok).toBe(true);
      if (pmFirst.ok) createdAnalysisRunIds.push(pmFirst.data.analysisRunId);

      // The seeded PM's allowance is now exhausted...
      const pmSecondCall = await runImpactAnalysis(
        EVENT_IDS.supplierDelay,
        DEMO_USER_IDS.programManager,
        {
          provider: new MockLLMProvider(),
          rateLimiter,
        },
      );
      expect(pmSecondCall.ok).toBe(false);
      if (!pmSecondCall.ok) expect(pmSecondCall.error.code).toBe("RATE_LIMITED");

      // ...but a second, distinct Program Manager under the exact same
      // shared limiter instance is completely unaffected.
      const otherPm = await runImpactAnalysis(EVENT_IDS.supplierDelay, secondPmId, {
        provider: new MockLLMProvider(),
        rateLimiter,
      });
      expect(otherPm.ok).toBe(true);
      if (otherPm.ok) await cleanupAnalysisRun(otherPm.data.analysisRunId);
    } finally {
      // The temp user must be deleted only after its own ImpactAnalysis
      // rows are gone (requestedById is a foreign key to User) — cleaned
      // up directly above rather than deferred to the shared afterEach,
      // which would otherwise still be holding a reference to this user
      // when it runs after this finally block already tried to delete it.
      await prisma.user.delete({ where: { id: secondPmId } });
    }
  });
});
