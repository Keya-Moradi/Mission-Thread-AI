import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../db";
import { PROGRAM_ID, DEMO_USER_IDS } from "../seed/ids";
import { recordProgramEvent } from "./record-program-event";

const validGeneralUpdate = {
  eventType: "GENERAL_UPDATE" as const,
  rawNotes: "Smoke-test note, safe to delete.",
};

const validSupplierDelay = {
  eventType: "SUPPLIER_DELAY" as const,
  componentId: "COMP-EC440",
  supplierId: "SUP-NORTHSTAR",
  originalDate: "2026-11-01",
  revisedDate: "2026-11-15",
  confidence: "MEDIUM" as const,
  quantity: 10,
};

// Every test creates its own uniquely-IDed rows and removes them
// afterward, rather than relying on execution order or leaving state for a
// later test to depend on.
const createdEventIds: string[] = [];
const createdUserIds: string[] = [];
const createdProgramIds: string[] = [];

afterEach(async () => {
  if (createdEventIds.length > 0) {
    await prisma.auditEvent.deleteMany({ where: { targetRecordId: { in: createdEventIds } } });
    await prisma.programEvent.deleteMany({ where: { id: { in: createdEventIds } } });
    createdEventIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  if (createdProgramIds.length > 0) {
    await prisma.component.deleteMany({ where: { programId: { in: createdProgramIds } } });
    await prisma.supplier.deleteMany({ where: { programId: { in: createdProgramIds } } });
    await prisma.program.deleteMany({ where: { id: { in: createdProgramIds } } });
    createdProgramIds.length = 0;
  }
});

describe("recordProgramEvent — validation", () => {
  it("[validation error] invalid input never reaches the database", async () => {
    const result = await recordProgramEvent(
      { eventType: "GENERAL_UPDATE", rawNotes: "" },
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("recordProgramEvent — authorization", () => {
  it("[Program Manager succeeds] the seeded PM can record a general update", async () => {
    const result = await recordProgramEvent(validGeneralUpdate, DEMO_USER_IDS.programManager);
    expect(result.ok).toBe(true);
    if (result.ok) createdEventIds.push(result.data.eventId);
  });

  it("[Engineering Lead is forbidden] cannot record an event", async () => {
    const result = await recordProgramEvent(validGeneralUpdate, DEMO_USER_IDS.engineeringLead);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[Executive Viewer is forbidden] cannot record an event", async () => {
    const result = await recordProgramEvent(validGeneralUpdate, DEMO_USER_IDS.executiveViewer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[missing user is rejected] an actor ID that never existed is FORBIDDEN", async () => {
    const result = await recordProgramEvent(validGeneralUpdate, "USER-DOES-NOT-EXIST");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[stale/deleted user is rejected] an actor ID that existed but was deleted is FORBIDDEN", async () => {
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

    const result = await recordProgramEvent(validGeneralUpdate, tempUserId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  });

  it("[role is revalidated from the database] a role change between calls is honored, not cached", async () => {
    const tempUserId = `USER-TEST-${randomUUID()}`;
    createdUserIds.push(tempUserId);
    await prisma.user.create({
      data: {
        id: tempUserId,
        email: `${tempUserId}@example.test`,
        name: "Temp role-change user",
        role: "PROGRAM_MANAGER",
        passwordHash: "unused",
      },
    });

    const firstResult = await recordProgramEvent(validGeneralUpdate, tempUserId);
    expect(firstResult.ok).toBe(true);
    if (firstResult.ok) createdEventIds.push(firstResult.data.eventId);

    await prisma.user.update({ where: { id: tempUserId }, data: { role: "EXECUTIVE_VIEWER" } });

    const secondResult = await recordProgramEvent(validGeneralUpdate, tempUserId);
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) expect(secondResult.error.code).toBe("FORBIDDEN");
  });
});

describe("recordProgramEvent — relationship validation", () => {
  it("[unknown component] a componentId that doesn't exist anywhere is NOT_FOUND", async () => {
    const result = await recordProgramEvent(
      { ...validSupplierDelay, componentId: "COMP-DOES-NOT-EXIST" },
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("[unknown supplier] a supplierId that doesn't exist anywhere is NOT_FOUND", async () => {
    const result = await recordProgramEvent(
      { ...validSupplierDelay, supplierId: "SUP-DOES-NOT-EXIST" },
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  describe("records that exist, but belong to a different program", () => {
    const otherProgramId = `PROGRAM-TEST-OTHER-${randomUUID()}`;
    const otherComponentId = `COMP-TEST-OTHER-${randomUUID()}`;
    const otherSupplierId = `SUP-TEST-OTHER-${randomUUID()}`;

    it("[component from another program] is NOT_FOUND, not merely rejected for belonging elsewhere", async () => {
      createdProgramIds.push(otherProgramId);
      await prisma.program.create({
        data: {
          id: otherProgramId,
          name: "Other test program",
          description: "Temp, deleted after test.",
        },
      });
      await prisma.component.create({
        data: {
          id: otherComponentId,
          programId: otherProgramId,
          name: "Other-program component",
          subsystem: "test",
          description: "temp",
        },
      });

      const result = await recordProgramEvent(
        { ...validSupplierDelay, componentId: otherComponentId },
        DEMO_USER_IDS.programManager,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("[supplier from another program] is NOT_FOUND, not merely rejected for belonging elsewhere", async () => {
      createdProgramIds.push(otherProgramId);
      await prisma.program.create({
        data: {
          id: otherProgramId,
          name: "Other test program",
          description: "Temp, deleted after test.",
        },
      });
      await prisma.supplier.create({
        data: {
          id: otherSupplierId,
          programId: otherProgramId,
          name: "Other-program supplier",
          contact: "temp",
        },
      });

      const result = await recordProgramEvent(
        { ...validSupplierDelay, supplierId: otherSupplierId },
        DEMO_USER_IDS.programManager,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
    });
  });
});

describe("recordProgramEvent — transaction behavior", () => {
  it("a successful supplier-delay event creates exactly one ProgramEvent and one matching AuditEvent sharing the trace ID", async () => {
    const result = await recordProgramEvent(validSupplierDelay, DEMO_USER_IDS.programManager);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdEventIds.push(result.data.eventId);

    const events = await prisma.programEvent.findMany({ where: { id: result.data.eventId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.delayDays).toBe(14);

    const auditEvents = await prisma.auditEvent.findMany({
      where: { targetRecordId: result.data.eventId },
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]?.action).toBe("EVENT_RECORDED");
    expect(auditEvents[0]?.actorType).toBe("USER");
    expect(auditEvents[0]?.targetRecordType).toBe("PROGRAM_EVENT");
    expect(auditEvents[0]?.traceId).toBe(result.data.traceId);
  });

  it("[audit payload excludes full reason and raw notes] only booleans and structured facts are stored", async () => {
    const result = await recordProgramEvent(
      { ...validSupplierDelay, reason: "a secret-shaped reason", rawNotes: "a secret-shaped note" },
      DEMO_USER_IDS.programManager,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdEventIds.push(result.data.eventId);

    const auditEvent = await prisma.auditEvent.findFirst({
      where: { targetRecordId: result.data.eventId },
    });
    const payload = JSON.stringify(auditEvent?.afterValue);
    expect(payload).not.toContain("secret-shaped reason");
    expect(payload).not.toContain("secret-shaped note");
    expect((auditEvent?.afterValue as Record<string, unknown>)?.hasReason).toBe(true);
    expect((auditEvent?.afterValue as Record<string, unknown>)?.hasRawNotes).toBe(true);
  });

  it("[rollback guarantee] this project's transaction pattern rolls back the first write when the second fails", async () => {
    // recordProgramEvent's own validation guarantees actorUserId always
    // exists by the time the transaction runs, so its second write can
    // never naturally fail through the public API — this test instead
    // proves the underlying pattern it relies on (two tx.* writes inside
    // one prisma.$transaction callback) actually rolls back in this
    // project's Postgres + @prisma/adapter-pg configuration, by forcing a
    // real foreign-key violation on the second write directly.
    const probeEventId = `EVT-TEST-ROLLBACK-${randomUUID()}`;

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.programEvent.create({
          data: {
            id: probeEventId,
            programId: PROGRAM_ID,
            eventType: "GENERAL_UPDATE",
            rawNotes: "should be rolled back",
            createdById: DEMO_USER_IDS.programManager,
          },
        });
        await tx.auditEvent.create({
          data: {
            traceId: randomUUID(),
            actorUserId: "USER-DOES-NOT-EXIST-FK-VIOLATION",
            actorType: "USER",
            action: "EVENT_RECORDED",
            targetRecordId: probeEventId,
            targetRecordType: "PROGRAM_EVENT",
          },
        });
      }),
    ).rejects.toThrow();

    const survived = await prisma.programEvent.findUnique({ where: { id: probeEventId } });
    expect(survived).toBeNull();
  });
});
