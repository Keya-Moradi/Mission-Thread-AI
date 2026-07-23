#!/usr/bin/env node
// Automated Phase 1 smoke test. Starts the production server (the caller
// must run `npm run build` first — see README "Quality gate commands")
// against whatever DATABASE_URL is already in the environment — CI and
// `npm run smoke:test` both point this at the dedicated test database,
// never the dev database — and exercises the auth + dashboard flow with
// real HTTP requests, the same checks that were previously only ever run
// by hand. Exits non-zero on any failed check, so it can gate CI like a
// unit test suite would.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { config as loadEnv } from "dotenv";
import pg from "pg";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(appDir, "..", "..");
// Resolved via Node's own module resolution (which walks up through
// node_modules directories) rather than a hardcoded relative path, since
// npm workspaces hoist `next` to the monorepo root's node_modules, not
// apps/web's own — a literal `apps/web/node_modules/.bin/next` path would
// never exist.
const nextBinPath = createRequire(import.meta.url).resolve("next/dist/bin/next");

// Always load .env.test explicitly, overriding any DATABASE_URL already in
// the shell environment — this script's entire purpose is to run against
// the dedicated test database (SPEC.md §14: "Integration tests must never
// depend on developer data"), so it must never silently fall back to
// whatever a developer's shell happens to have exported.
loadEnv({ path: path.join(rootDir, ".env.test"), override: true });

const PORT = process.env.SMOKE_TEST_PORT ?? "3100";
const BASE_URL = `http://localhost:${PORT}`;
const START_TIMEOUT_MS = 30_000;
// Belt-and-suspenders against the whole script ever hanging past this: a
// prior version of this script spawned the server via `npx`, an extra
// process layer that (on at least one environment observed in CI, though
// not reliably reproduced locally) did not reliably propagate SIGTERM down
// to the actual `next start` process, leaving the script's event loop alive
// indefinitely — several past CI runs were silently auto-cancelled after
// GitHub's 6-hour job timeout with no clear failure signal at all. This
// watchdog guarantees a fast, loud failure instead of a silent multi-hour
// hang, regardless of the exact cause.
const WATCHDOG_TIMEOUT_MS = 90_000;

const DEMO_EMAIL = "pm@missionthread.example";
const DEMO_PASSWORD = "MissionThread-Demo-2026!";
const DEMO_NAME = "Jordan Ellis";
const DEMO_USER_ID = "USER-PM";
const DEMO_ROLE = "PROGRAM_MANAGER";

// Same shared demo password as the Program Manager — used only to prove
// role-based access differs, never to submit anything.
const ENGINEERING_LEAD_EMAIL = "lead@missionthread.example";
const EXECUTIVE_VIEWER_EMAIL = "exec@missionthread.example";

// The one seeded demonstration analysis (packages/core/prisma/seed.ts,
// packages/core/src/seed/ids.ts) — fixed IDs, so this smoke test can assert
// on them directly without querying the database itself. AI_MODE is always
// "mock" wherever this script runs (see .env.test.example / ci.yml), so
// nothing in this run ever makes a real, paid provider request — only page
// views of the already-seeded fixture, never a fresh Analyze submission.
const SEEDED_ANALYSIS_RUN_ID = "RUN-EVT-SUPPLIER-001";
const SEEDED_ANALYSIS_TRACE_ID = "TRACE-ANALYSIS-EVT-SUPPLIER-001";
const SEEDED_ANALYSIS_ID = "ANALYSIS-EVT-SUPPLIER-001";
const SEEDED_MITIGATION_OPTION_ID = "MIT-EVT-SUPPLIER-001-1";
// A real seeded milestone — only ever referenced by a Decision's captured
// oldValue in this script, never mutated (applyApprovedChanges() is
// deliberately never called here — see "Phase 5 approval workflow" below).
const SEEDED_MILESTONE_ID = "MS-001";

let failureCount = 0;

function check(description, condition) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    failureCount += 1;
    console.error(`  FAIL ${description}`);
  }
}

/**
 * Verifies both that a response is a redirect AND that it actually points
 * at /login, not merely that its status code is 302/307 — a redirect to
 * the wrong place would previously have passed this check. Handles both
 * relative ("/login") and absolute ("http://host/login") Location headers
 * by resolving against BASE_URL, and requires no query string, since
 * requireSession()'s redirect("/login") never adds one — a query string
 * appearing would mean something unexpected changed in the redirect.
 */
function checkRedirectToLogin(description, response) {
  const isRedirectStatus = [302, 307].includes(response.status);
  check(`${description} (redirect status)`, isRedirectStatus);

  const location = response.headers.get("location");
  let destinationIsLogin = false;
  if (location) {
    try {
      const resolved = new URL(location, BASE_URL);
      destinationIsLogin = resolved.pathname === "/login" && resolved.search === "";
    } catch {
      destinationIsLogin = false;
    }
  }
  check(`${description} (destination is exactly /login)`, destinationIsLogin);
}

/**
 * Reads the text content of the first element carrying the given
 * data-testid attribute. Used instead of searching the whole page for a
 * bare value (e.g. `includes(">8<")`), which could pass because the number
 * happens to appear somewhere unrelated, such as a count that isn't the
 * one actually being checked.
 */
function getTestIdText(html, testId) {
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`));
  return match ? match[1].trim() : null;
}

/**
 * Counts elements carrying a given data-testid attribute. Deliberately not
 * a plain text-occurrence count: Next.js's App Router streams a serialized
 * RSC "flight" payload alongside the rendered HTML for hydration, which
 * re-embeds every rendered string a second time inside a <script> tag as
 * escaped JSON (`\"like this\"`) — a bare `html.match(/some text/g)` count
 * would therefore double-count everything. An exact, unescaped
 * `data-testid="..."` attribute match only appears in the actual rendered
 * markup, never inside that escaped payload, so this stays an accurate
 * count of real DOM elements.
 */
function countTestId(html, testId) {
  return (html.match(new RegExp(`data-testid="${testId}"`, "g")) ?? []).length;
}

/** Minimal cookie jar: tracks the latest value for each cookie name across
 * requests, the same way a browser (or curl -b/-c) would, since Auth.js's
 * credentials flow spans a CSRF-token request, a sign-in POST, and then
 * authenticated requests that must all share accumulated cookies. */
class CookieJar {
  #cookies = new Map();

  absorb(response) {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    for (const setCookie of setCookies) {
      const [pair] = setCookie.split(";");
      const separatorIndex = pair.indexOf("=");
      if (separatorIndex === -1) continue;
      const name = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);
      if (value === "" || setCookie.toLowerCase().includes("max-age=0")) {
        this.#cookies.delete(name);
      } else {
        this.#cookies.set(name, value);
      }
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasSessionCookie() {
    return [...this.#cookies.keys()].some((name) => name.includes("session-token"));
  }
}

/**
 * Bounded, cleaned-up-afterward test fixtures for the Phase 5 approval
 * workflow checks below — inserted directly via `pg` (not Prisma/tsx —
 * this script stays a plain Node script, run with plain `node`, matching
 * its original Phase 1 design decision, see docs/DECISIONS.md), and always
 * against `DATABASE_URL` as already forced to `.env.test` above, never the
 * dev database. Deliberately never calls applyApprovedChanges() or submits
 * the real decision/apply forms — this checks read-only page rendering
 * only ("without destructive application"); the one live end-to-end
 * approve → apply flow is covered by the Playwright happy-path test
 * instead (packages/core Server Actions have no stable external HTTP
 * contract this script could reproduce without a real browser).
 */
class Phase5Fixtures {
  #client;

  constructor(databaseUrl) {
    this.#client = new pg.Client({ connectionString: databaseUrl });
  }

  async connect() {
    await this.#client.connect();
  }

  async createPendingOption(id, optionIndex) {
    await this.#client.query(
      `INSERT INTO "MitigationOption"
         (id, "impactAnalysisId", "optionIndex", title, description, tradeoffs, "isRecommended", status)
       VALUES ($1, $2, $3, $4, $5, $6, false, 'PENDING')`,
      [
        id,
        SEEDED_ANALYSIS_ID,
        optionIndex,
        "Smoke-test mitigation option",
        "Created by apps/web/scripts/smoke-test.mjs; safe to delete.",
        "None — test fixture.",
      ],
    );
  }

  async createApprovedOptionWithProposedChange(
    optionId,
    optionIndex,
    decisionId,
    proposedChangeId,
  ) {
    await this.createPendingOption(optionId, optionIndex);
    await this.#client.query(
      `INSERT INTO "Decision" (id, "mitigationOptionId", "actorUserId", verdict, rationale, "traceId")
       VALUES ($1, $2, $3, 'APPROVED', $4, $5)`,
      [
        decisionId,
        optionId,
        DEMO_USER_ID,
        "Approved by the Phase 5 smoke-test fixture; safe to delete.",
        `TRACE-SMOKE-${decisionId}`,
      ],
    );
    await this.#client.query(`UPDATE "MitigationOption" SET status = 'APPROVED' WHERE id = $1`, [
      optionId,
    ]);
    await this.#client.query(
      `INSERT INTO "ProposedChange"
         (id, "mitigationOptionId", "changeType", "targetRecordId", "targetRecordType", "oldValue", "newValue", status)
       VALUES ($1, $2, 'MILESTONE_DATE', $3, 'MILESTONE', $4, $5, 'PENDING')`,
      [
        proposedChangeId,
        optionId,
        SEEDED_MILESTONE_ID,
        JSON.stringify({ currentDate: "2026-09-15" }),
        JSON.stringify({ currentDate: "2026-12-01" }),
      ],
    );
  }

  async cleanup(optionIds) {
    await this.#client.query(`DELETE FROM "AuditEvent" WHERE "targetRecordId" = ANY($1)`, [
      optionIds,
    ]);
    await this.#client.query(`DELETE FROM "ProposedChange" WHERE "mitigationOptionId" = ANY($1)`, [
      optionIds,
    ]);
    await this.#client.query(`DELETE FROM "Decision" WHERE "mitigationOptionId" = ANY($1)`, [
      optionIds,
    ]);
    await this.#client.query(`DELETE FROM "MitigationOption" WHERE id = ANY($1)`, [optionIds]);
  }

  async end() {
    await this.#client.end();
  }
}

async function waitForServer() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/login`);
      if (res.status === 200) return;
    } catch {
      // Server not accepting connections yet — keep polling.
    }
    await sleep(300);
  }
  throw new Error(`Server did not become ready within ${START_TIMEOUT_MS}ms`);
}

async function signIn(jar, email, password) {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  jar.absorb(csrfRes);
  const { csrfToken } = await csrfRes.json();

  const body = new URLSearchParams({
    email,
    password,
    csrfToken,
    redirectTo: "/",
    json: "true",
  });

  const signInRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
    body: body.toString(),
    redirect: "manual",
  });
  jar.absorb(signInRes);
  return signInRes;
}

async function main() {
  console.log(`Starting production server (next start -p ${PORT})...`);
  // Spawns the actual `next` binary directly, not through `npx` — one
  // fewer process layer between this script and the server it needs to be
  // able to reliably terminate. See WATCHDOG_TIMEOUT_MS above.
  const server = spawn(nextBinPath, ["start", "-p", PORT], {
    cwd: appDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer();
    console.log("Server is up.\n");

    console.log("Unauthenticated access:");
    const home = await fetch(`${BASE_URL}/`, { redirect: "manual" });
    checkRedirectToLogin("GET /", home);

    const program = await fetch(`${BASE_URL}/programs/edgelink-x`, { redirect: "manual" });
    checkRedirectToLogin("GET /programs/edgelink-x", program);

    const audit = await fetch(`${BASE_URL}/audit`, { redirect: "manual" });
    checkRedirectToLogin("GET /audit", audit);

    const eventEntry = await fetch(`${BASE_URL}/programs/edgelink-x/events/new`, {
      redirect: "manual",
    });
    checkRedirectToLogin("GET /programs/edgelink-x/events/new", eventEntry);

    const analysisUnauth = await fetch(
      `${BASE_URL}/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}`,
      { redirect: "manual" },
    );
    checkRedirectToLogin("GET /programs/edgelink-x/analyses/[id]", analysisUnauth);

    const briefingUnauth = await fetch(
      `${BASE_URL}/programs/edgelink-x/briefings/${SEEDED_ANALYSIS_RUN_ID}`,
      { redirect: "manual" },
    );
    checkRedirectToLogin("GET /programs/edgelink-x/briefings/[id]", briefingUnauth);

    console.log("\nLogin page:");
    const loginPage = await fetch(`${BASE_URL}/login`);
    const loginHtml = await loginPage.text();
    check("GET /login returns 200", loginPage.status === 200);
    check(
      "GET /login renders the sign-in form",
      loginHtml.includes("Sign in") && loginHtml.includes(DEMO_EMAIL),
    );

    console.log("\nInvalid credentials:");
    const badJar = new CookieJar();
    await signIn(badJar, DEMO_EMAIL, "definitely-wrong-password");
    check("wrong password does not set a session cookie", !badJar.hasSessionCookie());
    const badHome = await fetch(`${BASE_URL}/`, {
      headers: { Cookie: badJar.header() },
      redirect: "manual",
    });
    checkRedirectToLogin("GET / with a wrong-password session", badHome);

    console.log("\nValid seeded credentials:");
    const jar = new CookieJar();
    const signInRes = await signIn(jar, DEMO_EMAIL, DEMO_PASSWORD);
    check(
      "credentials sign-in succeeds (redirect response)",
      [200, 302].includes(signInRes.status),
    );
    check("a session cookie is set after sign-in", jar.hasSessionCookie());

    console.log("\nAuthenticated dashboard:");
    const dashboard = await fetch(`${BASE_URL}/`, { headers: { Cookie: jar.header() } });
    const dashboardHtml = await dashboard.text();
    check("authenticated GET / returns 200", dashboard.status === 200);
    check("dashboard shows the signed-in user's name", dashboardHtml.includes(DEMO_NAME));
    check(
      "dashboard shows the signed-in user's role label",
      dashboardHtml.includes("Program Manager"),
    );
    check("dashboard shows the seeded program name", dashboardHtml.includes("EdgeLink-X"));
    check(
      "dashboard shows the executive dashboard heading",
      dashboardHtml.includes("Executive Dashboard"),
    );
    check(
      "dashboard's requirement-count label reads 'Requirements'",
      getTestIdText(dashboardHtml, "stat-label-requirementCount") === "Requirements",
    );
    check(
      "dashboard's requirement-count value is the seeded count (8)",
      getTestIdText(dashboardHtml, "stat-value-requirementCount") === "8",
    );
    check(
      "dashboard shows a readiness score (Phase 2 calculateReadinessScore, real data)",
      /readiness-score/.test(dashboardHtml) &&
        !dashboardHtml.includes('data-testid="readiness-score">—'),
    );
    check(
      "dashboard shows a Record event link for the Program Manager",
      dashboardHtml.includes("Record event"),
    );

    console.log("\nSession contents:");
    const sessionRes = await fetch(`${BASE_URL}/api/auth/session`, {
      headers: { Cookie: jar.header() },
    });
    const session = await sessionRes.json();
    check("session contains the expected user id", session?.user?.id === DEMO_USER_ID);
    check("session contains the expected role", session?.user?.role === DEMO_ROLE);

    console.log("\nAuthenticated nav routes:");
    const programAuthed = await fetch(`${BASE_URL}/programs/edgelink-x`, {
      headers: { Cookie: jar.header() },
    });
    const programHtml = await programAuthed.text();
    check("GET /programs/edgelink-x returns 200 when authenticated", programAuthed.status === 200);
    check(
      "program overview renders real database sections",
      [
        "Components and subsystems",
        "Requirements and component traceability",
        "Milestones",
        "Dependency relationships",
        "Risk register",
        "Test outcomes and verification coverage",
        "Budget items and variance",
        "Suppliers",
        "Recent events",
      ].every((heading) => programHtml.includes(heading)),
    );
    check(
      "program overview shows a seeded component by name",
      programHtml.includes("EC-440 Compute Module"),
    );

    const auditAuthed = await fetch(`${BASE_URL}/audit`, { headers: { Cookie: jar.header() } });
    const auditHtml = await auditAuthed.text();
    check("GET /audit returns 200 when authenticated", auditAuthed.status === 200);
    check("audit page renders the audit history heading", auditHtml.includes("Audit History"));
    check(
      "audit page shows the seeded EVENT_RECORDED fixture for the supplier-delay event",
      auditHtml.includes("TRACE-EVT-SUPPLIER-001") && auditHtml.includes("EVT-SUPPLIER-001"),
    );

    console.log("\nSeeded analysis workspace:");
    const analysisPage = await fetch(
      `${BASE_URL}/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}`,
      { headers: { Cookie: jar.header() } },
    );
    const analysisHtml = await analysisPage.text();
    check("GET /programs/edgelink-x/analyses/[id] returns 200", analysisPage.status === 200);
    check(
      "analysis workspace shows the seeded trace ID",
      analysisHtml.includes(SEEDED_ANALYSIS_TRACE_ID),
    );
    check(
      "analysis workspace shows exactly 3 mitigation option cards",
      countTestId(analysisHtml, "mitigation-option") === 3,
    );
    check(
      "analysis workspace marks exactly 1 option as recommended",
      countTestId(analysisHtml, "mitigation-recommended-badge") === 1,
    );
    check(
      "analysis workspace links to the readiness briefing",
      analysisHtml.includes(`/programs/edgelink-x/briefings/${SEEDED_ANALYSIS_RUN_ID}`),
    );

    console.log("\nSeeded readiness briefing:");
    const briefingPage = await fetch(
      `${BASE_URL}/programs/edgelink-x/briefings/${SEEDED_ANALYSIS_RUN_ID}`,
      { headers: { Cookie: jar.header() } },
    );
    const briefingHtml = await briefingPage.text();
    check("GET /programs/edgelink-x/briefings/[id] returns 200", briefingPage.status === 200);
    check("briefing shows the seeded trace ID", briefingHtml.includes(SEEDED_ANALYSIS_TRACE_ID));
    check("briefing shows a confidence badge", briefingHtml.includes("MEDIUM"));
    check(
      "briefing shows assumptions and unknowns sections",
      briefingHtml.includes("Assumptions") && briefingHtml.includes("Unknowns"),
    );
    check(
      "briefing shows a source references section",
      briefingHtml.includes("Source references") && briefingHtml.includes("EVT-SUPPLIER-001"),
    );
    check(
      "briefing states the options are pending human review, not applied",
      briefingHtml.includes("pending human Program Manager"),
    );

    console.log("\nEvent-entry access (role-based):");
    const eventEntryAsPm = await fetch(`${BASE_URL}/programs/edgelink-x/events/new`, {
      headers: { Cookie: jar.header() },
    });
    const eventEntryHtml = await eventEntryAsPm.text();
    check("Program Manager can access the event-entry page (200)", eventEntryAsPm.status === 200);
    check(
      "event-entry page renders the form",
      eventEntryHtml.includes("Record a program event") && eventEntryHtml.includes("Record event"),
    );

    const leadJar = new CookieJar();
    await signIn(leadJar, ENGINEERING_LEAD_EMAIL, DEMO_PASSWORD);
    check("Engineering Lead sign-in succeeds", leadJar.hasSessionCookie());
    const eventEntryAsLead = await fetch(`${BASE_URL}/programs/edgelink-x/events/new`, {
      headers: { Cookie: leadJar.header() },
      redirect: "manual",
    });
    check(
      "Engineering Lead is redirected away from the event-entry page, not shown the form",
      [307, 302].includes(eventEntryAsLead.status),
    );
    const dashboardAsLead = await fetch(`${BASE_URL}/`, { headers: { Cookie: leadJar.header() } });
    const dashboardAsLeadHtml = await dashboardAsLead.text();
    check(
      "Engineering Lead does not see a Record event link",
      dashboardAsLead.status === 200 && !dashboardAsLeadHtml.includes("Record event"),
    );

    console.log("\nAnalysis access (role-based):");
    const analysisAsLead = await fetch(
      `${BASE_URL}/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}`,
      { headers: { Cookie: leadJar.header() } },
    );
    check("Engineering Lead can view the seeded analysis (200)", analysisAsLead.status === 200);
    const programAsLead = await fetch(`${BASE_URL}/programs/edgelink-x`, {
      headers: { Cookie: leadJar.header() },
    });
    const programAsLeadHtml = await programAsLead.text();
    check(
      "Engineering Lead does not see an Analyze control on the program overview",
      programAsLead.status === 200 && !programAsLeadHtml.includes(">Analyze<"),
    );
    check(
      "Program Manager does see an Analyze control on the program overview",
      programHtml.includes(">Analyze<"),
    );

    console.log("\nPhase 5 approval workflow — unauthenticated access:");
    const decisionUnauth = await fetch(
      `${BASE_URL}/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}/options/${SEEDED_MITIGATION_OPTION_ID}/decision`,
      { redirect: "manual" },
    );
    checkRedirectToLogin(
      "GET /programs/edgelink-x/analyses/[id]/options/[optionId]/decision",
      decisionUnauth,
    );
    const applyUnauth = await fetch(
      `${BASE_URL}/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}/options/${SEEDED_MITIGATION_OPTION_ID}/apply`,
      { redirect: "manual" },
    );
    checkRedirectToLogin(
      "GET /programs/edgelink-x/analyses/[id]/options/[optionId]/apply",
      applyUnauth,
    );

    console.log("\nPhase 5 approval workflow — controlled test fixtures:");
    const fixtures = new Phase5Fixtures(process.env.DATABASE_URL);
    await fixtures.connect();
    const pendingOptionId = `MIT-SMOKE-PENDING-${Date.now()}`;
    const approvedOptionId = `MIT-SMOKE-APPROVED-${Date.now()}`;
    const decisionId = `DEC-SMOKE-${Date.now()}`;
    const proposedChangeId = `PC-SMOKE-${Date.now()}`;
    try {
      await fixtures.createPendingOption(pendingOptionId, 9001);
      await fixtures.createApprovedOptionWithProposedChange(
        approvedOptionId,
        9002,
        decisionId,
        proposedChangeId,
      );

      const decisionUrl = (optionId) =>
        `${BASE_URL}/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}/options/${optionId}/decision`;
      const applyUrl = (optionId) =>
        `${BASE_URL}/programs/edgelink-x/analyses/${SEEDED_ANALYSIS_RUN_ID}/options/${optionId}/apply`;

      console.log("\nPhase 5 decision page — role-based controls:");
      const decisionAsPm = await fetch(decisionUrl(pendingOptionId), {
        headers: { Cookie: jar.header() },
      });
      const decisionAsPmHtml = await decisionAsPm.text();
      check(
        "Program Manager can view a pending option's decision page (200)",
        decisionAsPm.status === 200,
      );
      check(
        "Program Manager sees Approve and Reject controls",
        decisionAsPmHtml.includes('value="APPROVED"') &&
          decisionAsPmHtml.includes('value="REJECTED"'),
      );

      const decisionAsLead = await fetch(decisionUrl(pendingOptionId), {
        headers: { Cookie: leadJar.header() },
      });
      const decisionAsLeadHtml = await decisionAsLead.text();
      check("Engineering Lead can view the decision page (200)", decisionAsLead.status === 200);
      check(
        "Engineering Lead sees Request revision but not Approve or Reject",
        decisionAsLeadHtml.includes('value="REVISION_REQUESTED"') &&
          !decisionAsLeadHtml.includes('value="APPROVED"') &&
          !decisionAsLeadHtml.includes('value="REJECTED"'),
      );

      const execJar = new CookieJar();
      await signIn(execJar, EXECUTIVE_VIEWER_EMAIL, DEMO_PASSWORD);
      check("Executive Viewer sign-in succeeds", execJar.hasSessionCookie());
      const decisionAsExec = await fetch(decisionUrl(pendingOptionId), {
        headers: { Cookie: execJar.header() },
      });
      const decisionAsExecHtml = await decisionAsExec.text();
      check("Executive Viewer can view the decision page (200)", decisionAsExec.status === 200);
      check(
        "Executive Viewer sees no mutation controls (no verdict radio inputs)",
        !decisionAsExecHtml.includes('name="verdict"'),
      );

      console.log("\nPhase 5 apply-preview page — controlled fixture:");
      const applyAsPm = await fetch(applyUrl(approvedOptionId), {
        headers: { Cookie: jar.header() },
      });
      const applyAsPmHtml = await applyAsPm.text();
      check("Program Manager can view the apply-preview page (200)", applyAsPm.status === 200);
      check(
        "apply preview states nothing has been applied yet",
        applyAsPmHtml.includes("Nothing has been applied yet"),
      );
      check(
        "apply preview shows the proposed change's target and old/new values",
        applyAsPmHtml.includes(SEEDED_MILESTONE_ID) &&
          applyAsPmHtml.includes("2026-09-15") &&
          applyAsPmHtml.includes("2026-12-01"),
      );
      check(
        "apply preview shows an Apply control for the Program Manager",
        applyAsPmHtml.includes("Apply changes"),
      );

      const applyAsLead = await fetch(applyUrl(approvedOptionId), {
        headers: { Cookie: leadJar.header() },
      });
      const applyAsLeadHtml = await applyAsLead.text();
      check("Engineering Lead can view the apply-preview page (200)", applyAsLead.status === 200);
      check(
        "Engineering Lead sees no Apply control (read-only)",
        !applyAsLeadHtml.includes("Apply changes"),
      );
    } finally {
      await fixtures.cleanup([pendingOptionId, approvedOptionId]);
      await fixtures.end();
    }

    console.log("\nSign-out:");
    const signOutCsrfRes = await fetch(`${BASE_URL}/api/auth/csrf`, {
      headers: { Cookie: jar.header() },
    });
    jar.absorb(signOutCsrfRes);
    const { csrfToken: signOutCsrf } = await signOutCsrfRes.json();
    const signOutRes = await fetch(`${BASE_URL}/api/auth/signout`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: jar.header() },
      body: new URLSearchParams({ csrfToken: signOutCsrf, json: "true" }).toString(),
      redirect: "manual",
    });
    jar.absorb(signOutRes);
    check("sign-out request succeeds", [200, 302].includes(signOutRes.status));

    const afterSignOut = await fetch(`${BASE_URL}/`, {
      headers: { Cookie: jar.header() },
      redirect: "manual",
    });
    checkRedirectToLogin("GET / after sign-out", afterSignOut);

    console.log("\nServer logs:");
    const unexpectedErrors = serverOutput
      .split("\n")
      .filter((line) => /error/i.test(line))
      .filter((line) => !line.includes("CredentialsSignin")); // expected, from the wrong-password check above
    check(
      "no unexpected server-side errors were logged during the run",
      unexpectedErrors.length === 0,
    );
    if (unexpectedErrors.length > 0) {
      console.error(unexpectedErrors.join("\n"));
    }
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    // If the server process (or a descendant of it) is still alive here,
    // don't wait on it — forcibly kill it too, and don't let its still-open
    // stdio pipes keep this script's event loop alive below.
    if (server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
    }
  }

  console.log("");
  const exitCode = failureCount > 0 ? 1 : 0;
  if (failureCount > 0) {
    console.error(`Smoke test FAILED: ${failureCount} check(s) did not pass.`);
  } else {
    console.log("Smoke test PASSED: all checks succeeded.");
  }
  // Explicit exit, not a natural event-loop drain: guarantees this process
  // terminates even if something (e.g. a not-fully-reaped server
  // descendant holding a pipe open) would otherwise keep it alive — see
  // WATCHDOG_TIMEOUT_MS above for the fuller story.
  process.exit(exitCode);
}

const watchdog = setTimeout(() => {
  console.error(
    `Smoke test FAILED: did not complete within ${WATCHDOG_TIMEOUT_MS}ms (watchdog fired).`,
  );
  process.exit(1);
}, WATCHDOG_TIMEOUT_MS);
watchdog.unref();

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exitCode = 1;
});
