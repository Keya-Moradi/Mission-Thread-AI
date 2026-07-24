import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { DEMO_USER_IDS, EVENT_IDS } from "../seed/ids";
import { MockLLMProvider } from "./mock-provider";
import { runImpactAnalysis } from "./orchestrator";

// Phase 6 §10 authorization/mutation security regression tests — added
// only where they verify a real boundary not already covered by
// orchestrator.test.ts's existing per-role FORBIDDEN coverage.

const createdAnalysisRunIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  for (const runId of createdAnalysisRunIds) {
    const analyses = await prisma.impactAnalysis.findMany({
      where: { analysisRunId: runId },
      select: { id: true },
    });
    const ids = analyses.map((a) => a.id);
    if (ids.length > 0) {
      await prisma.auditEvent.deleteMany({ where: { targetRecordId: { in: ids } } });
      await prisma.sourceReference.deleteMany({ where: { impactAnalysisId: { in: ids } } });
      await prisma.mitigationOption.deleteMany({ where: { impactAnalysisId: { in: ids } } });
      await prisma.impactAnalysis.deleteMany({ where: { id: { in: ids } } });
    }
  }
  createdAnalysisRunIds.length = 0;
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

describe("runImpactAnalysis — role reloaded fresh on every request", () => {
  it("[role change mid-session] a demotion between two calls is honored on the very next call, not deferred to a new session", async () => {
    const tempUserId = `USER-TEST-ROLE-CHANGE-${randomUUID()}`;
    createdUserIds.push(tempUserId);
    await prisma.user.create({
      data: {
        id: tempUserId,
        email: `${tempUserId}@example.test`,
        name: "Temp role-change actor",
        role: "PROGRAM_MANAGER",
        passwordHash: "unused",
      },
    });

    const first = await runImpactAnalysis(EVENT_IDS.supplierDelay, tempUserId, {
      provider: new MockLLMProvider(),
    });
    expect(first.ok).toBe(true);
    if (first.ok) createdAnalysisRunIds.push(first.data.analysisRunId);

    await prisma.user.update({ where: { id: tempUserId }, data: { role: "EXECUTIVE_VIEWER" } });

    const second = await runImpactAnalysis(EVENT_IDS.supplierDelay, tempUserId, {
      provider: new MockLLMProvider(),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("FORBIDDEN");

    await prisma.user.update({ where: { id: tempUserId }, data: { role: "PROGRAM_MANAGER" } });

    const third = await runImpactAnalysis(EVENT_IDS.supplierDelay, tempUserId, {
      provider: new MockLLMProvider(),
    });
    expect(third.ok).toBe(true);
    if (third.ok) createdAnalysisRunIds.push(third.data.analysisRunId);
  });
});

describe("runImpactAnalysis — AI output cannot mutate approval/apply state", () => {
  it("[zero Decision/ProposedChange rows after any outcome] a successful analysis creates mitigation options only, never a Decision or ProposedChange", async () => {
    const result = await runImpactAnalysis(EVENT_IDS.supplierDelay, DEMO_USER_IDS.programManager, {
      provider: new MockLLMProvider(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdAnalysisRunIds.push(result.data.analysisRunId);

    const options = await prisma.mitigationOption.findMany({
      where: { impactAnalysisId: result.data.finalAnalysisId },
    });
    expect(options.length).toBe(3);

    const decisions = await prisma.decision.findMany({
      where: { mitigationOptionId: { in: options.map((o) => o.id) } },
    });
    expect(decisions).toHaveLength(0);

    const proposedChanges = await prisma.proposedChange.findMany({
      where: { mitigationOptionId: { in: options.map((o) => o.id) } },
    });
    expect(proposedChanges).toHaveLength(0);
  });
});

describe("packages/core/src/ai — structural isolation from the approval/apply layer", () => {
  it("[no ai/*.ts file imports from ../approvals] the AI layer has no code path capable of invoking recordMitigationDecision()/applyApprovedChanges()", () => {
    const aiDir = join(__dirname);
    const violations: string[] = [];
    for (const entry of readdirSync(aiDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
      const fullPath = join(aiDir, entry.name);
      const content = readFileSync(fullPath, "utf8");
      if (/from\s+["']\.\.\/approvals/.test(content)) {
        violations.push(fullPath);
      }
    }
    expect(violations).toEqual([]);
  });

  it("[sanity check] the scan directory actually contains real AI source files", () => {
    const files = readdirSync(join(__dirname)).filter((f) => /\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(5);
  });
});
