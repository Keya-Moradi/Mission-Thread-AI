#!/usr/bin/env node
// Bounded, read-only HTTP check that the *containerized* build actually
// works — a complement to apps/web/scripts/smoke-test.mjs (which spawns
// `next start` itself against the raw build output), not a replacement for
// it. This script never starts or stops the container itself — the caller
// (.github/workflows/ci.yml's "Docker runtime smoke test" step, or a local
// equivalent) is responsible for `docker run`/cleanup; this script only
// waits for an already-started container's HTTP server to answer, signs in
// with the standard seeded demo credential, and confirms an authenticated,
// database-backed page renders real seeded data. It performs no database
// write of any kind, no reset, no seed.
//
// Required env: DOCKER_RUNTIME_CHECK_BASE_URL (e.g. http://localhost:3300).

import { CookieJar, getTestIdText, signIn, waitForServer } from "./lib/http-auth-client.mjs";

const BASE_URL = process.env.DOCKER_RUNTIME_CHECK_BASE_URL;
if (!BASE_URL) {
  console.error("DOCKER_RUNTIME_CHECK_BASE_URL is required.");
  process.exitCode = 1;
  process.exit();
}

const START_TIMEOUT_MS = 30_000;
const DEMO_EMAIL = "pm@missionthread.example";
const DEMO_PASSWORD = "MissionThread-Demo-2026!";

let failureCount = 0;
function check(description, condition) {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    failureCount += 1;
    console.error(`  FAIL ${description}`);
  }
}

async function main() {
  console.log(`Waiting for ${BASE_URL}/login (up to ${START_TIMEOUT_MS}ms)...`);
  await waitForServer(BASE_URL, START_TIMEOUT_MS);
  console.log("Container is answering HTTP requests.\n");

  const loginRes = await fetch(`${BASE_URL}/login`);
  const loginHtml = await loginRes.text();
  check("GET /login returns 200", loginRes.status === 200);
  check("login page renders the sign-in form", loginHtml.includes('id="email"'));

  const jar = new CookieJar();
  const signInRes = await signIn(BASE_URL, jar, DEMO_EMAIL, DEMO_PASSWORD);
  check("credentials sign-in succeeds (redirect response)", [302, 307].includes(signInRes.status));
  check("a session cookie is set after sign-in", jar.hasSessionCookie());

  const dashboardRes = await fetch(`${BASE_URL}/`, { headers: { Cookie: jar.header() } });
  const dashboardHtml = await dashboardRes.text();
  check("authenticated GET / returns 200", dashboardRes.status === 200);
  check(
    "dashboard's requirement-count value is the seeded count (8)",
    getTestIdText(dashboardHtml, "stat-value-requirementCount") === "8",
  );

  console.log(
    failureCount === 0
      ? "\nDocker runtime check PASSED: all checks succeeded."
      : `\nDocker runtime check FAILED: ${failureCount} check(s) failed.`,
  );
  process.exitCode = failureCount === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("Docker runtime check crashed:", error);
  process.exitCode = 1;
});
