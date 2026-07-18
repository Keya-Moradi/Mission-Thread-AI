import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { PROGRAM_ID, DEMO_USER_IDS } from "../seed/ids";
import { addUtcDays, calculateScheduleExposure, utcDayDifference } from "./schedule";

describe("utcDayDifference / addUtcDays — pure, DB-free UTC calendar-day arithmetic", () => {
  it("[the 28-day seed case] 2026-09-15 -> 2026-10-13 is exactly 28 days", () => {
    expect(utcDayDifference(new Date("2026-09-15"), new Date("2026-10-13"))).toBe(28);
  });

  it("[same-day] a date compared to itself is 0 days", () => {
    const date = new Date("2026-05-01");
    expect(utcDayDifference(date, date)).toBe(0);
  });

  it("[reversed dates] a later `from` than `to` gives a negative day count", () => {
    expect(utcDayDifference(new Date("2026-10-13"), new Date("2026-09-15"))).toBe(-28);
  });

  it("[month boundary] Jan 28 -> Feb 3 (non-leap year) is 6 days", () => {
    expect(utcDayDifference(new Date("2027-01-28"), new Date("2027-02-03"))).toBe(6);
  });

  it("[leap year] Feb 28 -> Mar 1, 2028 (a leap year) is 2 days, not 1", () => {
    expect(utcDayDifference(new Date("2028-02-28"), new Date("2028-03-01"))).toBe(2);
  });

  it("addUtcDays shifts across a month boundary correctly", () => {
    expect(addUtcDays(new Date("2026-01-01"), 31).toISOString().slice(0, 10)).toBe("2026-02-01");
  });
});

describe("calculateScheduleExposure — DB-backed, against the seeded test database", () => {
  it("[validation] an empty event ID returns VALIDATION_ERROR", async () => {
    const result = await calculateScheduleExposure("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("[not found] an unknown event ID returns NOT_FOUND", async () => {
    const result = await calculateScheduleExposure("EVT-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[the seeded 28-day case] EVT-SUPPLIER-001's dates, delay, and cascade are all consistent", async () => {
    const result = await calculateScheduleExposure("EVT-SUPPLIER-001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.originalDate).toBe("2026-09-15");
    expect(result.data.revisedDate).toBe("2026-10-13");
    expect(result.data.directDelayDays).toBe(28);
    expect(result.data.storedDelayDays).toBe(28);
    expect(result.data.delayDaysConsistent).toBe(true);
    expect(result.data.directMilestoneIds).toEqual(["MS-001", "MS-002", "MS-008"]);
    expect(result.data.dependencyDerivedMilestoneIds).toEqual(["MS-006"]);
    expect(result.data.impactedMilestoneIds).toEqual(["MS-001", "MS-002", "MS-006", "MS-008"]);
  });

  it("[dependency propagation] latestExposedDate is MS-008's planned date shifted by the direct delay", async () => {
    const result = await calculateScheduleExposure("EVT-SUPPLIER-001");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // MS-008 is planned 2026-10-25; +28 days = 2026-11-22, later than every
    // other impacted milestone's shifted date.
    expect(result.data.latestExposedDate).toBe("2026-11-22");
  });

  it("[missing dates] a general-update event with no dates reports missingData instead of guessing", async () => {
    const result = await calculateScheduleExposure("EVT-002");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.originalDate).toBeNull();
    expect(result.data.directDelayDays).toBeNull();
    expect(result.data.delayDaysConsistent).toBeNull();
    expect(result.data.latestExposedDate).toBeNull();
    expect(result.data.missingData.length).toBeGreaterThan(0);
  });

  it("[deterministic repeatability] repeated calls return the identical result", async () => {
    const first = await calculateScheduleExposure("EVT-SUPPLIER-001");
    const second = await calculateScheduleExposure("EVT-SUPPLIER-001");
    expect(first).toEqual(second);
  });

  describe("[schedule inconsistency] a temporary event whose stored delayDays disagrees with its dates", () => {
    const inconsistentEventId = "EVT-TEST-INCONSISTENT-DELAY";

    beforeAll(async () => {
      await prisma.programEvent.create({
        data: {
          id: inconsistentEventId,
          programId: PROGRAM_ID,
          eventType: "SUPPLIER_DELAY",
          componentId: null,
          originalDate: new Date("2026-01-01"),
          revisedDate: new Date("2026-01-11"), // 10 actual days
          delayDays: 99, // deliberately wrong
          createdById: DEMO_USER_IDS.programManager,
        },
      });
    });

    afterAll(async () => {
      await prisma.programEvent.delete({ where: { id: inconsistentEventId } });
    });

    it("is detected and reported, not silently accepted", async () => {
      const result = await calculateScheduleExposure(inconsistentEventId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.directDelayDays).toBe(10);
      expect(result.data.storedDelayDays).toBe(99);
      expect(result.data.delayDaysConsistent).toBe(false);
      expect(result.data.missingData.some((m) => m.includes("disagrees"))).toBe(true);
    });
  });
});
