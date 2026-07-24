import { test, expect } from "@playwright/test";
import { assertPlaywrightTestDatabaseTarget } from "./playwright-test-environment";

// The seeded Program Manager and demonstration analysis (packages/core/src/
// seed/ids.ts, prisma/seed.ts) — fixed across every reset, matching
// apps/web/scripts/smoke-test.mjs's constants.
const PM_EMAIL = "pm@missionthread.example";
const PM_PASSWORD = "MissionThread-Demo-2026!";
const PM_NAME = "Jordan Ellis";
const SEEDED_ANALYSIS_RUN_ID = "RUN-EVT-SUPPLIER-001";
const SEEDED_MILESTONE_ID = "MS-001";
const SEEDED_MILESTONE_NAME = "EC-440 Fabrication Complete";
const NEW_MILESTONE_DATE = "2027-03-01";

test.describe.configure({ mode: "serial" });

/**
 * `@missionthread/core`'s root barrel re-exports `db.ts`'s `prisma`, which
 * constructs a real PrismaClient — reading `process.env.DATABASE_URL` —
 * the moment it's imported. A static top-level `import { prisma } from
 * "@missionthread/core"` would therefore have already connected before
 * this file gets any chance to check what it's connecting to.
 * `assertPlaywrightTestDatabaseTarget()` runs first, against whatever
 * `playwright.config.ts` actually resolved this process's `DATABASE_URL`
 * to be — never assuming that resolution definitely happened — and only
 * the `require()` call after it ever triggers Prisma's construction.
 * Deliberately `require()`, not `await import()`: Playwright compiles this
 * file to CommonJS and installs its own `require` hook to transpile
 * workspace `.ts` sources on demand (the same mechanism that already
 * resolves `@missionthread/core/db-safety` in playwright-test-environment.ts);
 * a genuine ESM dynamic `import()` from inside that CommonJS module instead
 * goes through Node's own native loader for a second, independent load of
 * the same package, which produced a real, reproducible failure resolving
 * `packages/core/src/db-safety.ts`'s named exports from within
 * `index.ts`'s re-export. Staying on the one loader `db-safety`'s own
 * subpath import already proved works avoids that entirely. See
 * docs/DECISIONS.md, "Phase 5 correction: Playwright database-isolation
 * repair".
 */
async function getPlaywrightTestPrisma() {
  assertPlaywrightTestDatabaseTarget(process.env);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate: see the doc comment above for why this must stay require(), not await import().
  const { prisma } = require("@missionthread/core") as typeof import("@missionthread/core");

  // Belt-and-suspenders beyond the URL-tuple check above: the database
  // name alone (checked here) doesn't verify host/port, which is exactly
  // why the tuple check above remains mandatory — but confirming the
  // *actual live connection* reports the expected database catches
  // anything the URL string alone couldn't (e.g. a DNS/connection-pooling
  // layer silently redirecting somewhere else).
  const rows = await prisma.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  const currentDatabase = rows[0]?.current_database;
  if (currentDatabase !== "missionthread_test") {
    throw new Error(
      `Refusing to proceed: the active database connection reports "${currentDatabase}", expected "missionthread_test".`,
    );
  }

  return prisma;
}

test("Program Manager approves a mitigation option and applies its proposed change", async ({
  page,
}) => {
  // Throws before any query — including this test's own cleanup — can run
  // if the active database target isn't an approved local test tuple. See
  // getPlaywrightTestPrisma()'s own doc comment above.
  const prisma = await getPlaywrightTestPrisma();

  // Captured before this test changes anything, so the milestone can be
  // restored to its exact prior value afterward regardless of how the test
  // finishes — this suite must never perform a full database reset in
  // teardown (that's a separate, explicitly authorized `npm run
  // db:reset:test` run before the suite starts, not something this test
  // does itself). See README.md and docs/DECISIONS.md, "Phase 5
  // correction: non-destructive Playwright command".
  const milestoneBefore = await prisma.milestone.findUniqueOrThrow({
    where: { id: SEEDED_MILESTONE_ID },
  });
  let optionId: string | null = null;

  try {
    // 1. Sign in as the Program Manager.
    await page.goto("/login");
    await page.getByLabel("Email").fill(PM_EMAIL);
    await page.getByLabel("Password").fill(PM_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/");

    // 2. Open the seeded successful analysis.
    await page.goto(`/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}`);
    await expect(page.getByRole("heading", { name: "Impact analysis" })).toBeVisible();
    await expect(page.getByTestId("mitigation-option")).toHaveCount(3);

    // 3. Choose one pending mitigation option and open its decision page.
    await page.getByRole("link", { name: "Record a decision" }).first().click();
    await expect(page.getByRole("heading", { name: "Mitigation option decision" })).toBeVisible();
    optionId = new URL(page.url()).pathname.split("/").at(-2)!;

    // 4. Approve with one safe milestone-date proposed change.
    await page
      .getByLabel("Rationale")
      .fill(
        "Approved via the Playwright happy-path test — a single, low-risk milestone-date adjustment.",
      );
    await page.getByLabel("Target milestone").selectOption({ label: SEEDED_MILESTONE_NAME });
    await page.getByLabel("New current date").fill(NEW_MILESTONE_DATE);
    await page.getByRole("button", { name: "Submit decision" }).click();

    // 5. Redirected into the apply preview.
    await expect(page).toHaveURL(new RegExp(`/options/${optionId}/apply$`));
    const main = page.getByRole("main");
    await expect(page.getByRole("heading", { name: "Apply preview" })).toBeVisible();
    await expect(page.getByText("Nothing has been applied yet")).toBeVisible();
    await expect(main.getByText(PM_NAME)).toBeVisible();
    await expect(main.getByText(NEW_MILESTONE_DATE)).toBeVisible();

    // 6. Enter the explicit confirmation and apply.
    await page.getByLabel("Type APPLY to confirm").fill("APPLY");
    await page.getByRole("button", { name: "Apply changes" }).click();

    // 7. Verify the applied state.
    await expect(page).toHaveURL(new RegExp(`/options/${optionId}/apply\\?applied=1$`));
    await expect(page.getByText("Changes applied successfully")).toBeVisible();
    await expect(page.getByText("MILESTONE DATE")).toBeVisible();

    // 8. The mitigation option now shows APPROVED on the analysis workspace.
    // Every option card links to its own decision/apply pages — locate the
    // one matching this test's optionId instead of relying on card order.
    await page.goto(`/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}`);
    const decidedCard = page.locator('[data-testid="mitigation-option"]', {
      has: page.locator(`a[href*="${optionId}"]`),
    });
    await expect(decidedCard.getByText("APPROVED", { exact: true })).toBeVisible();

    // 9. The actual Milestone row reflects the new date.
    await page.goto("/programs/edgelink-x");
    const milestoneRow = page.locator("tr", { hasText: SEEDED_MILESTONE_NAME });
    await expect(milestoneRow).toContainText(NEW_MILESTONE_DATE);

    // 10. The audit trail contains both DECISION_RECORDED and CHANGES_APPLIED
    // for this mitigation option.
    await page.goto(`/audit?action=DECISION_RECORDED&targetType=MITIGATION_OPTION`);
    await expect(page.getByText(optionId)).toBeVisible();

    await page.goto(`/audit?action=CHANGES_APPLIED&targetType=MITIGATION_OPTION`);
    await expect(page.getByText(optionId)).toBeVisible();
  } finally {
    // Bounded cleanup: restore only the exact records this run changed, in
    // `missionthread_test`, so the suite is safely repeatable without
    // another reset — never a full database reset here. Every step is
    // idempotent (deleteMany/updateMany, not delete/update) so this still
    // runs safely even if the test failed partway through and some of
    // these records were never created. Never reached at all if
    // getPlaywrightTestPrisma() above ever threw — see its doc comment.
    if (optionId) {
      await prisma.auditEvent.deleteMany({
        where: {
          targetRecordId: optionId,
          action: { in: ["DECISION_RECORDED", "CHANGES_APPLIED"] },
        },
      });
      await prisma.proposedChange.deleteMany({ where: { mitigationOptionId: optionId } });
      await prisma.decision.deleteMany({ where: { mitigationOptionId: optionId } });
      await prisma.mitigationOption.updateMany({
        where: { id: optionId },
        data: { status: "PENDING" },
      });
    }
    await prisma.milestone.update({
      where: { id: SEEDED_MILESTONE_ID },
      data: { currentDate: milestoneBefore.currentDate },
    });
  }
});
