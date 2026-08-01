// Documentation tool, not part of any test suite or CI step. Captures PNG
// screenshots of the seeded demo program for README/docs use. Run manually
// against a server you've already started (e.g. `npm run dev` or `npm run
// start --workspace @missionthread/web`) with AI_MODE=mock and the standard
// seeded missionthread_dev database — see "npm run docs:screenshots" in the
// root package.json and README.md's "Diagrams and screenshots" section.
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
  await shoot(page, "02-dashboard", { fullPage: true });

  await goto(page, "/programs/edgelink-x");
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
