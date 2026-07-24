import { test, expect } from "@playwright/test";
import { prisma } from "@missionthread/core";

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

test("Program Manager approves a mitigation option and applies its proposed change", async ({
  page,
}) => {
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
    // these records were never created.
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
