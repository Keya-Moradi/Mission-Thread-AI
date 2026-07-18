import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { PROGRAM_ID, DEMO_USER_IDS } from "../seed/ids";
import { calculateBudgetExposure, calculateBudgetVariance, sumCurrencyGroup } from "./budget";

function decimalItem(id: string, planned: string, actual: string) {
  return {
    id,
    plannedAmount: new Prisma.Decimal(planned),
    actualAmount: new Prisma.Decimal(actual),
  };
}

describe("sumCurrencyGroup — pure, decimal-safe arithmetic", () => {
  it("[overrun] actual greater than planned gives a positive variance", () => {
    const result = sumCurrencyGroup("USD", [decimalItem("A", "100.00", "150.00")]);
    expect(result.plannedTotal).toBe("100.00");
    expect(result.actualTotal).toBe("150.00");
    expect(result.varianceAmount).toBe("50.00");
    expect(result.variancePercentage).toBe(50);
  });

  it("[underrun] actual less than planned gives a negative variance", () => {
    const result = sumCurrencyGroup("USD", [decimalItem("A", "1000.00", "900.00")]);
    expect(result.varianceAmount).toBe("-100.00");
    expect(result.variancePercentage).toBe(-10);
  });

  it("[zero planned amount] division by zero is handled safely (null, not Infinity/NaN)", () => {
    const result = sumCurrencyGroup("USD", [decimalItem("A", "0.00", "100.00")]);
    expect(result.varianceAmount).toBe("100.00");
    expect(result.variancePercentage).toBeNull();
  });

  it("[exact equality] planned equals actual gives zero variance and zero percentage, not null", () => {
    const result = sumCurrencyGroup("USD", [decimalItem("A", "500.00", "500.00")]);
    expect(result.varianceAmount).toBe("0.00");
    expect(result.variancePercentage).toBe(0);
  });

  it("[decimal safety] fractional cents sum exactly, not via binary-float drift", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; Decimal must get this exact.
    const result = sumCurrencyGroup("USD", [
      decimalItem("A", "0.10", "0.10"),
      decimalItem("B", "0.20", "0.20"),
    ]);
    expect(result.plannedTotal).toBe("0.30");
  });
});

describe("calculateBudgetVariance — DB-backed, against the seeded test database", () => {
  it("[not found] an unknown program ID returns NOT_FOUND", async () => {
    const result = await calculateBudgetVariance("PROGRAM-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[real seed totals] EdgeLink-X's 5 budget items sum to a single-currency USD overrun", async () => {
    const result = await calculateBudgetVariance(PROGRAM_ID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.currency).toBe("USD");
    expect(result.data.plannedTotal).toBe("964000.00");
    expect(result.data.actualTotal).toBe("971500.00");
    expect(result.data.varianceAmount).toBe("7500.00");
    expect(result.data.variancePercentage).toBeCloseTo(0.778, 2);
    expect(result.data.contributingBudgetItemIds).toEqual([
      "BUDGET-001",
      "BUDGET-002",
      "BUDGET-003",
      "BUDGET-004",
      "BUDGET-005",
    ]);
    expect(result.data.missingData).toEqual([]);
  });

  it("[deterministic repeatability] repeated calls return the identical result", async () => {
    const first = await calculateBudgetVariance(PROGRAM_ID);
    const second = await calculateBudgetVariance(PROGRAM_ID);
    expect(first).toEqual(second);
  });

  describe("[currency consistency] a temporary program with items in two currencies", () => {
    const tempProgramId = "PROGRAM-TEST-MIXED-CURRENCY";

    beforeAll(async () => {
      await prisma.program.create({
        data: {
          id: tempProgramId,
          name: "Temp mixed-currency test program",
          description: "Deleted in afterAll.",
        },
      });
      await prisma.budgetItem.createMany({
        data: [
          {
            id: "BUDGET-TEST-USD",
            programId: tempProgramId,
            category: "Test",
            description: "USD item",
            plannedAmount: "100.00",
            actualAmount: "110.00",
            currency: "USD",
          },
          {
            id: "BUDGET-TEST-EUR",
            programId: tempProgramId,
            category: "Test",
            description: "EUR item",
            plannedAmount: "50.00",
            actualAmount: "50.00",
            currency: "EUR",
          },
        ],
      });
    });

    afterAll(async () => {
      await prisma.budgetItem.deleteMany({ where: { programId: tempProgramId } });
      await prisma.program.delete({ where: { id: tempProgramId } });
    });

    it("never combines totals across currencies; top-level fields are null and byCurrency carries both", async () => {
      const result = await calculateBudgetVariance(tempProgramId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.currency).toBeNull();
      expect(result.data.plannedTotal).toBeNull();
      expect(result.data.byCurrency).toHaveLength(2);
      expect(result.data.byCurrency.map((g) => g.currency)).toEqual(["EUR", "USD"]);
      expect(result.data.missingData.some((m) => m.includes("multiple currencies"))).toBe(true);
    });
  });
});

describe("calculateBudgetExposure — DB-backed, against the seeded test database", () => {
  it("[not found] an unknown event ID returns NOT_FOUND", async () => {
    const result = await calculateBudgetExposure("EVT-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[seeded supplier delay] EVT-SUPPLIER-001 exposes exactly BUDGET-001, the EC-440-linked item", async () => {
    const result = await calculateBudgetExposure("EVT-SUPPLIER-001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.componentId).toBe("COMP-EC440");
    expect(result.data.exposedBudgetItems.map((i) => i.budgetItemId)).toEqual(["BUDGET-001"]);
    expect(result.data.totalPlanned).toBe("480000.00");
    expect(result.data.totalActual).toBe("480000.00");
    expect(result.data.currentVarianceTotal).toBe("0.00");
    expect(result.data.totalDeterministicExposure).toBe("480000.00");
    expect(
      result.data.missingData.some((m) => m.toLowerCase().includes("incremental delay cost")),
    ).toBe(true);
  });

  describe("edge cases needing a temporary event not present in the standard seed", () => {
    const noComponentEventId = "EVT-TEST-NO-COMPONENT";
    const noBudgetItemsEventId = "EVT-TEST-NO-BUDGET-ITEMS";

    beforeAll(async () => {
      await prisma.programEvent.createMany({
        data: [
          {
            id: noComponentEventId,
            programId: PROGRAM_ID,
            eventType: "GENERAL_UPDATE",
            componentId: null,
            rawNotes: "Temp fixture: event with no linked component.",
            createdById: DEMO_USER_IDS.programManager,
          },
          {
            id: noBudgetItemsEventId,
            programId: PROGRAM_ID,
            eventType: "GENERAL_UPDATE",
            componentId: "COMP-DMS",
            rawNotes: "Temp fixture: event linked to a component with zero budget items.",
            createdById: DEMO_USER_IDS.programManager,
          },
        ],
      });
    });

    afterAll(async () => {
      await prisma.programEvent.deleteMany({
        where: { id: { in: [noComponentEventId, noBudgetItemsEventId] } },
      });
    });

    it("an event with no linked component has no exposed budget items", async () => {
      const result = await calculateBudgetExposure(noComponentEventId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.componentId).toBeNull();
      expect(result.data.exposedBudgetItems).toEqual([]);
      expect(result.data.totalDeterministicExposure).toBeNull();
    });

    it("an event linked to a component with zero budget items reports that explicitly", async () => {
      const result = await calculateBudgetExposure(noBudgetItemsEventId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.componentId).toBe("COMP-DMS");
      expect(result.data.exposedBudgetItems).toEqual([]);
      expect(result.data.missingData.some((m) => m.includes("No budget items found"))).toBe(true);
    });
  });
});
