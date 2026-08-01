// Documentation tool, not part of any test suite or CI step. Captures PNG
// screenshots of the seeded demo program for README/docs use. Run manually
// against a server you've already started (e.g. `npm run dev` or `npm run
// start --workspace @missionthread/web`) with AI_MODE=mock and the standard
// seeded missionthread_dev database — see "npm run docs:screenshots" in the
// root package.json and README.md's "Diagrams and screenshots" section.
//
// Deterministic and safe by design:
// - Content-validated, not just reachable: after signing in, this script
//   confirms the dashboard shows the exact known deterministic seed values
//   (program name, requirement count) before taking any further
//   screenshot — see checkSeededContent() below — so it refuses to run
//   (and writes no screenshots) against an unexpected or unseeded
//   database, without needing its own direct database connection.
// - No hidden reset, no fixture creation: this script never seeds, resets,
//   or writes anything — it only navigates already-rendered pages and
//   reads their HTML. There is nothing for it to clean up.
// - The program-overview capture is deliberately clipped to end before
//   "Recent events": that section renders submitted supplier/program notes
//   verbatim, clearly labeled untrusted (see
//   apps/web/src/app/(app)/programs/edgelink-x/page.tsx), and the seeded
//   demo data includes a scripted prompt-injection example sentence in
//   exactly that section (packages/core/prisma/seed.ts) — safe to display
//   inside the application's own labeled UI, but not the kind of content
//   that belongs baked into a committed screenshot artifact.
//
// Uses "domcontentloaded" + a short fixed settle delay rather than
// "networkidle": this app has no long-lived polling/streaming connection
// today, but "networkidle" waits for a quiet network window with no
// explicit cap of its own and would hang indefinitely against any future
// page that adds one (e.g. a live status poll).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = process.env.SCREENSHOT_OUT_DIR ?? "docs/assets/screenshots";
mkdirSync(OUT_DIR, { recursive: true });

// The standard, publicly documented local-development-only demo credential
// (README.md "Demo accounts") — not a real secret, authenticates only
// against the reader's own local database.
const EMAIL = "pm@missionthread.example";
const PASSWORD = "MissionThread-Demo-2026!";

async function goto(page, path) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForTimeout(500);
}

async function shoot(page, name, options) {
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, ...options });
  console.log(`  wrote ${name}.png`);
}

/**
 * Refuses to proceed unless the exact known deterministic seed values are
 * present — the one concrete way this HTTP-only script can validate its
 * target without its own database connection. Aborts loudly (no screenshot
 * written for this or any later page) rather than silently screenshotting
 * an unexpected environment.
 */
async function checkSeededContent(page) {
  const html = await page.content();
  const hasSeededProgram = html.includes("EdgeLink-X");
  const hasSeededRequirementCount = /data-testid="stat-value-requirementCount"[^>]*>\s*8\s*</.test(
    html,
  );
  if (!hasSeededProgram || !hasSeededRequirementCount) {
    throw new Error(
      "Refusing to continue: the dashboard does not show the expected deterministic " +
        "seed values (program 'EdgeLink-X', requirement count 8). This script only ever " +
        "screenshots the known, fictional seeded demo program — re-run " +
        "`npm run db:seed:dev:destructive` (fresh authorization required) against the " +
        "database this server is pointed at, then try again.",
    );
  }
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  await goto(page, "/login");
  await shoot(page, "01-login");

  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${BASE_URL}/`, { timeout: 15_000 });
  await page.waitForTimeout(500);
  await checkSeededContent(page);
  await shoot(page, "02-dashboard", { fullPage: true });

  await goto(page, "/programs/edgelink-x");
  // The "Recent events" section is hidden (not clipped by pixel position)
  // before this screenshot — see the file header comment for why. Hiding
  // the actual DOM section and then taking a normal fullPage screenshot
  // sidesteps any ambiguity about whether clip/bounding-box coordinates are
  // viewport- or document-relative: the hidden section simply collapses out
  // of the page's layout entirely, the same as if it were never rendered.
  const recentEventsHeadingCount = await page
    .getByRole("heading", { name: "Recent events" })
    .count();
  if (recentEventsHeadingCount === 0) {
    throw new Error('Could not locate the "Recent events" heading on the program overview page.');
  }
  await page.evaluate(() => {
    const heading = [...document.querySelectorAll("h2")].find(
      (element) => element.textContent === "Recent events",
    );
    const section = heading?.closest("section");
    if (section) section.style.display = "none";
  });
  await shoot(page, "03-program-overview", { fullPage: true });

  await goto(page, "/programs/edgelink-x/events/new");
  await shoot(page, "04-event-entry", { fullPage: true });

  await goto(page, "/programs/edgelink-x/thread");
  // React Flow needs a moment to lay out and render the canvas.
  await page.waitForTimeout(1500);
  await shoot(page, "05-digital-thread-graph");

  // The thread page's accessible, non-canvas fallback list is where analysis
  // run and decision links actually live (see build-program-thread.ts) —
  // found here rather than a hardcoded seed ID, so this script has no
  // seed-ID knowledge to go stale.
  const analysisHref = await page
    .locator('a[href^="/programs/edgelink-x/analyses/"]:not([href*="/options/"])')
    .first()
    .getAttribute("href")
    .catch(() => null);
  const threadDecisionHref = await page
    .locator('a[href*="/decision"]')
    .first()
    .getAttribute("href")
    .catch(() => null);

  await goto(page, "/audit");
  await shoot(page, "09-audit", { fullPage: true });

  if (analysisHref) {
    await goto(page, analysisHref);
    await shoot(page, "06-analysis-workspace", { fullPage: true });

    const briefingHref = await page
      .locator('a[href*="/briefings/"]')
      .first()
      .getAttribute("href")
      .catch(() => null);
    if (briefingHref) {
      await goto(page, briefingHref);
      await shoot(page, "07-readiness-briefing", { fullPage: true });
    }

    if (threadDecisionHref) {
      await goto(page, threadDecisionHref);
      await shoot(page, "08-decision-page", { fullPage: true });
    }
  } else {
    console.log("  no seeded analysis link found — skipped 06/07/08");
  }

  await browser.close();
  console.log(`Done. Wrote screenshots to ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
