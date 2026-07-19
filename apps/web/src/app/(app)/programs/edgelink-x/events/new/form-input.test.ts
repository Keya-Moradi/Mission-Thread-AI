import { describe, expect, it } from "vitest";
import { eventEntrySchema } from "@missionthread/core";
import { buildEventEntryInputFromFormData } from "./form-input";

function formDataFrom(fields: Record<string, string | File>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

const validSupplierDelayFields = {
  eventType: "SUPPLIER_DELAY",
  componentId: "COMP-EC440",
  supplierId: "SUP-NORTHSTAR",
  originalDate: "2026-09-15",
  revisedDate: "2026-10-13",
  confidence: "MEDIUM",
  quantity: "40",
};

const validGeneralUpdateFields = {
  eventType: "GENERAL_UPDATE",
  rawNotes: "No schedule impact.",
};

describe("buildEventEntryInputFromFormData — discriminator branching", () => {
  it("[exact SUPPLIER_DELAY] builds a supplier-delay candidate", () => {
    const result = buildEventEntryInputFromFormData(formDataFrom(validSupplierDelayFields));
    expect(result).toMatchObject({
      eventType: "SUPPLIER_DELAY",
      componentId: "COMP-EC440",
      supplierId: "SUP-NORTHSTAR",
      originalDate: "2026-09-15",
      revisedDate: "2026-10-13",
      confidence: "MEDIUM",
      quantity: 40,
    });
  });

  it("[exact GENERAL_UPDATE] builds a general-update candidate", () => {
    const result = buildEventEntryInputFromFormData(formDataFrom(validGeneralUpdateFields));
    expect(result).toMatchObject({
      eventType: "GENERAL_UPDATE",
      rawNotes: "No schedule impact.",
    });
  });

  it("[unrecognized discriminator] SOMETHING_ELSE is preserved verbatim, not converted to GENERAL_UPDATE", () => {
    const result = buildEventEntryInputFromFormData(
      formDataFrom({ eventType: "SOMETHING_ELSE", rawNotes: "otherwise valid notes" }),
    );
    expect(result).toEqual({ eventType: "SOMETHING_ELSE" });
  });

  it("[missing eventType] is reduced to an empty-string candidate, not GENERAL_UPDATE", () => {
    const result = buildEventEntryInputFromFormData(
      formDataFrom({ rawNotes: "no eventType field at all" }),
    );
    expect(result).toEqual({ eventType: "" });
  });

  it('[empty eventType] "" is preserved, not converted to GENERAL_UPDATE', () => {
    const result = buildEventEntryInputFromFormData(
      formDataFrom({ eventType: "", rawNotes: "empty discriminator" }),
    );
    expect(result).toEqual({ eventType: "" });
  });

  it("[non-string FormData value] a File value for eventType is reduced to an empty-string candidate", () => {
    const formData = new FormData();
    formData.set("eventType", new File(["not a string"], "eventType.txt"));
    formData.set("rawNotes", "a File was submitted for eventType");
    const result = buildEventEntryInputFromFormData(formData);
    expect(result).toEqual({ eventType: "" });
  });

  it.each([
    "supplier_delay",
    "Supplier_Delay",
    "GENERAL_UPDATE ",
    " GENERAL_UPDATE",
    "general_update",
  ])(
    "[malformed event types cannot create a general update] %j never produces a GENERAL_UPDATE candidate",
    (eventType) => {
      const result = buildEventEntryInputFromFormData(formDataFrom({ eventType, rawNotes: "x" }));
      expect(result).toEqual({ eventType });
    },
  );

  it("[valid submissions continue to parse] a valid SUPPLIER_DELAY submission passes eventEntrySchema", () => {
    const raw = buildEventEntryInputFromFormData(formDataFrom(validSupplierDelayFields));
    expect(eventEntrySchema.safeParse(raw).success).toBe(true);
  });

  it("[valid submissions continue to parse] a valid GENERAL_UPDATE submission passes eventEntrySchema", () => {
    const raw = buildEventEntryInputFromFormData(formDataFrom(validGeneralUpdateFields));
    expect(eventEntrySchema.safeParse(raw).success).toBe(true);
  });
});

describe("buildEventEntryInputFromFormData — regression: an unrecognized discriminator never reaches eventEntrySchema as valid", () => {
  it("eventType=SOMETHING_ELSE with otherwise-valid rawNotes does not pass eventEntrySchema", () => {
    const raw = buildEventEntryInputFromFormData(
      formDataFrom({ eventType: "SOMETHING_ELSE", rawNotes: "otherwise valid notes" }),
    );
    const result = eventEntrySchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it("this previously passed as a GENERAL_UPDATE before the fix (documented failure mode)", () => {
    // Before the fix, buildRawInput()'s fallback branch defaulted any
    // non-SUPPLIER_DELAY eventType to "GENERAL_UPDATE", so this exact
    // input would have silently become a valid general-update candidate
    // and passed eventEntrySchema. It must not anymore.
    const raw = buildEventEntryInputFromFormData(
      formDataFrom({ eventType: "SOMETHING_ELSE", rawNotes: "otherwise valid notes" }),
    );
    expect(raw).not.toMatchObject({ eventType: "GENERAL_UPDATE" });
    expect(eventEntrySchema.safeParse(raw).success).toBe(false);
  });
});
