import { describe, expect, it } from "vitest";
import {
  dateOnlySchema,
  eventEntrySchema,
  MAX_QUANTITY,
  MAX_RAW_NOTES_LENGTH,
  MAX_REASON_LENGTH,
} from "./schemas";

const validSupplierDelay = {
  eventType: "SUPPLIER_DELAY" as const,
  componentId: "COMP-EC440",
  supplierId: "SUP-NORTHSTAR",
  originalDate: "2026-09-15",
  revisedDate: "2026-10-13",
  confidence: "MEDIUM" as const,
  quantity: 40,
  reason: "fabrication yield problem",
  rawNotes: "Some supplier note.",
};

const validGeneralUpdate = {
  eventType: "GENERAL_UPDATE" as const,
  rawNotes: "No schedule impact.",
};

describe("dateOnlySchema — pure date-format and calendar validity", () => {
  it("accepts a valid YYYY-MM-DD date", () => {
    expect(dateOnlySchema.safeParse("2026-09-15").success).toBe(true);
  });

  it.each(["09/15/2026", "2026-9-15", "2026-09-15T00:00:00Z", "not-a-date", ""])(
    "[invalid dates] rejects malformed input %j",
    (value) => {
      expect(dateOnlySchema.safeParse(value).success).toBe(false);
    },
  );

  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31"])(
    "[impossible calendar date] rejects %j even though it matches the format",
    (value) => {
      expect(dateOnlySchema.safeParse(value).success).toBe(false);
    },
  );

  it("accepts Feb 29 in a leap year and rejects it in a non-leap year", () => {
    expect(dateOnlySchema.safeParse("2028-02-29").success).toBe(true);
    expect(dateOnlySchema.safeParse("2027-02-29").success).toBe(false);
  });
});

describe("eventEntrySchema — SUPPLIER_DELAY", () => {
  it("[valid] accepts a fully valid supplier delay", () => {
    const result = eventEntrySchema.safeParse(validSupplierDelay);
    expect(result.success).toBe(true);
  });

  it("[valid] accepts a supplier delay without optional reason/rawNotes", () => {
    const { reason, rawNotes, ...withoutOptional } = validSupplierDelay;
    void reason;
    void rawNotes;
    expect(eventEntrySchema.safeParse(withoutOptional).success).toBe(true);
  });

  it("[revised date before original] is rejected", () => {
    const result = eventEntrySchema.safeParse({
      ...validSupplierDelay,
      originalDate: "2026-10-13",
      revisedDate: "2026-09-15",
    });
    expect(result.success).toBe(false);
  });

  it("[revised date equal to original] is rejected — must be strictly later", () => {
    const result = eventEntrySchema.safeParse({
      ...validSupplierDelay,
      originalDate: "2026-09-15",
      revisedDate: "2026-09-15",
    });
    expect(result.success).toBe(false);
  });

  it.each(["componentId", "supplierId", "originalDate", "revisedDate", "confidence", "quantity"])(
    "[missing required field] rejects when %s is absent",
    (field) => {
      const input = { ...validSupplierDelay } as Record<string, unknown>;
      delete input[field];
      expect(eventEntrySchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([0, -1, -100])("[non-positive quantity] rejects %j", (quantity) => {
    expect(eventEntrySchema.safeParse({ ...validSupplierDelay, quantity }).success).toBe(false);
  });

  it("[quantity too large] rejects a quantity over the documented maximum", () => {
    expect(
      eventEntrySchema.safeParse({ ...validSupplierDelay, quantity: MAX_QUANTITY + 1 }).success,
    ).toBe(false);
  });

  it("[quantity must be an integer] rejects a fractional quantity", () => {
    expect(eventEntrySchema.safeParse({ ...validSupplierDelay, quantity: 40.5 }).success).toBe(
      false,
    );
  });

  it("[oversized text] rejects a reason over the documented maximum length", () => {
    expect(
      eventEntrySchema.safeParse({
        ...validSupplierDelay,
        reason: "x".repeat(MAX_REASON_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("[oversized text] rejects rawNotes over the documented maximum length", () => {
    expect(
      eventEntrySchema.safeParse({
        ...validSupplierDelay,
        rawNotes: "x".repeat(MAX_RAW_NOTES_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("[unknown fields] rejects an unrecognized field", () => {
    expect(
      eventEntrySchema.safeParse({ ...validSupplierDelay, unexpectedField: "surprise" }).success,
    ).toBe(false);
  });

  it("[client-supplied delay field rejected] delayDays is not part of the contract and is rejected as unknown", () => {
    expect(eventEntrySchema.safeParse({ ...validSupplierDelay, delayDays: 28 }).success).toBe(
      false,
    );
  });

  it("[invalid confidence] rejects a value outside the enum", () => {
    expect(
      eventEntrySchema.safeParse({ ...validSupplierDelay, confidence: "VERY_HIGH" }).success,
    ).toBe(false);
  });
});

describe("eventEntrySchema — GENERAL_UPDATE", () => {
  it("[valid] accepts a general update with only rawNotes", () => {
    expect(eventEntrySchema.safeParse(validGeneralUpdate).success).toBe(true);
  });

  it("[valid] accepts an optional component and supplier", () => {
    expect(
      eventEntrySchema.safeParse({
        ...validGeneralUpdate,
        componentId: "COMP-BATTERY",
        supplierId: "SUP-IRONVALE",
      }).success,
    ).toBe(true);
  });

  it("[missing required field] rejects an empty rawNotes", () => {
    expect(eventEntrySchema.safeParse({ eventType: "GENERAL_UPDATE", rawNotes: "" }).success).toBe(
      false,
    );
  });

  it("[missing required field] rejects a whitespace-only rawNotes", () => {
    expect(
      eventEntrySchema.safeParse({ eventType: "GENERAL_UPDATE", rawNotes: "   " }).success,
    ).toBe(false);
  });

  it("[does not accept supplier-delay-only fields] rejects originalDate/revisedDate/confidence/quantity", () => {
    expect(
      eventEntrySchema.safeParse({ ...validGeneralUpdate, originalDate: "2026-09-15" }).success,
    ).toBe(false);
    expect(eventEntrySchema.safeParse({ ...validGeneralUpdate, confidence: "HIGH" }).success).toBe(
      false,
    );
    expect(eventEntrySchema.safeParse({ ...validGeneralUpdate, quantity: 10 }).success).toBe(false);
  });

  it("[unknown fields] rejects an unrecognized field", () => {
    expect(
      eventEntrySchema.safeParse({ ...validGeneralUpdate, unexpectedField: "surprise" }).success,
    ).toBe(false);
  });

  it("[oversized text] rejects rawNotes over the documented maximum length", () => {
    expect(
      eventEntrySchema.safeParse({ rawNotes: "x".repeat(MAX_RAW_NOTES_LENGTH + 1) }).success,
    ).toBe(false);
  });
});

describe("eventEntrySchema — general", () => {
  it("[unknown eventType] rejects an eventType outside the union", () => {
    expect(eventEntrySchema.safeParse({ eventType: "SOMETHING_ELSE", rawNotes: "x" }).success).toBe(
      false,
    );
  });

  it("[missing eventType] rejects input with no eventType at all", () => {
    expect(eventEntrySchema.safeParse({ rawNotes: "x" }).success).toBe(false);
  });
});
