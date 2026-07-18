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
import { config as loadEnv } from "dotenv";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(appDir, "..", "..");

// Always load .env.test explicitly, overriding any DATABASE_URL already in
// the shell environment — this script's entire purpose is to run against
// the dedicated test database (SPEC.md §14: "Integration tests must never
// depend on developer data"), so it must never silently fall back to
// whatever a developer's shell happens to have exported.
loadEnv({ path: path.join(rootDir, ".env.test"), override: true });

const PORT = process.env.SMOKE_TEST_PORT ?? "3100";
const BASE_URL = `http://localhost:${PORT}`;
const START_TIMEOUT_MS = 30_000;

const DEMO_EMAIL = "pm@missionthread.example";
const DEMO_PASSWORD = "MissionThread-Demo-2026!";
const DEMO_NAME = "Jordan Ellis";
const DEMO_USER_ID = "USER-PM";
const DEMO_ROLE = "PROGRAM_MANAGER";

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
  const server = spawn("npx", ["next", "start", "-p", PORT], {
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
      "dashboard's requirement-count label reads 'Requirements'",
      getTestIdText(dashboardHtml, "stat-label-requirementCount") === "Requirements",
    );
    check(
      "dashboard's requirement-count value is the seeded count (8)",
      getTestIdText(dashboardHtml, "stat-value-requirementCount") === "8",
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
    check("GET /programs/edgelink-x returns 200 when authenticated", programAuthed.status === 200);
    const auditAuthed = await fetch(`${BASE_URL}/audit`, { headers: { Cookie: jar.header() } });
    check("GET /audit returns 200 when authenticated", auditAuthed.status === 200);

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
  }

  console.log("");
  if (failureCount > 0) {
    console.error(`Smoke test FAILED: ${failureCount} check(s) did not pass.`);
    process.exitCode = 1;
  } else {
    console.log("Smoke test PASSED: all checks succeeded.");
  }
}

main().catch((error) => {
  console.error("Smoke test crashed:", error);
  process.exitCode = 1;
});
