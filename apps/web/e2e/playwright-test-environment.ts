import {
  findApprovedDatabaseTarget,
  sanitizeDatabaseUrl,
  LOCAL_TEST_TARGETS,
  GITHUB_ACTIONS_TEST_TARGETS,
  type SafeDatabaseTarget,
} from "@missionthread/core/db-safety";

// Imported via the narrow "@missionthread/core/db-safety" subpath, never
// the package's root barrel ("@missionthread/core") — db-safety.ts has no
// imports of its own and performs no side effects, but the root barrel
// re-exports packages/core/src/db.ts's `prisma`, which constructs a real
// PrismaClient (reading process.env.DATABASE_URL) the moment it's
// imported. Reusing the exact same LOCAL_TEST_TARGETS/
// GITHUB_ACTIONS_TEST_TARGETS tuples and findApprovedDatabaseTarget()
// logic this project's other destructive-operation guards already use
// means there is exactly one place that defines what counts as an
// approved test-database target, not a second, independently maintained
// allowlist. See docs/DECISIONS.md, "Phase 5 correction: Playwright
// database-isolation repair".

/**
 * Every target this Playwright suite may ever connect to: the two local
 * loopback spellings of the Docker Compose test database, plus the GitHub
 * Actions service-container tuple — the latter only actually matches when
 * `findApprovedDatabaseTarget()` also sees `GITHUB_ACTIONS === "true"` in
 * the environment passed to it (see `GITHUB_ACTIONS_TEST_TARGETS`'s own
 * `requiresGitHubActions` flag in db-safety.ts). This suite isn't wired
 * into CI yet, but the resolver stays correct if it ever is.
 */
const APPROVED_PLAYWRIGHT_TEST_TARGETS = [...LOCAL_TEST_TARGETS, ...GITHUB_ACTIONS_TEST_TARGETS];

export class PlaywrightTestEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaywrightTestEnvironmentError";
  }
}

export interface ResolvedPlaywrightTestEnvironment {
  /** DATABASE_URL plus every other key .env.test defines — safe to spread directly into a child process's env or into process.env. */
  env: Record<string, string>;
  /** Host/port/database only — never the raw URL, username, password, or query string. */
  target: SafeDatabaseTarget;
}

/**
 * Resolves the one authoritative environment this Playwright suite may
 * run against, from `.env.test`'s own parsed content only — never from
 * whatever an invoking shell's ambient `DATABASE_URL` happens to already
 * be. Pure and side-effect-free: performs no file I/O and never touches
 * `process.env` itself; the caller (playwright.config.ts) is responsible
 * for actually loading `.env.test` and for applying the returned `env`
 * wherever it's needed.
 *
 * `ambientEnv` is consulted only for the `GITHUB_ACTIONS` check inside
 * `findApprovedDatabaseTarget()` — it never influences which
 * `DATABASE_URL` is selected, only whether the GitHub Actions target
 * tuple specifically is allowed to match. This is what makes the "ambient
 * shell has DATABASE_URL=.../missionthread_dev, but .env.test says
 * .../missionthread_test" case resolve correctly: the ambient value is
 * never read for that purpose at all.
 */
export function resolvePlaywrightTestEnvironment(
  ambientEnv: NodeJS.ProcessEnv,
  parsedTestEnv: Record<string, string> | undefined,
): ResolvedPlaywrightTestEnvironment {
  if (!parsedTestEnv) {
    throw new PlaywrightTestEnvironmentError(
      "Failed to load .env.test — the Playwright suite refuses to run without it.",
    );
  }

  const databaseUrl = parsedTestEnv.DATABASE_URL;
  if (!databaseUrl) {
    throw new PlaywrightTestEnvironmentError(".env.test does not define DATABASE_URL.");
  }

  const target = sanitizeDatabaseUrl(databaseUrl);
  if (!target) {
    throw new PlaywrightTestEnvironmentError(
      "DATABASE_URL in .env.test could not be parsed as a URL.",
    );
  }

  const approved = findApprovedDatabaseTarget(target, APPROVED_PLAYWRIGHT_TEST_TARGETS, ambientEnv);
  if (!approved) {
    throw new PlaywrightTestEnvironmentError(
      `.env.test's DATABASE_URL target ("${target.host}:${target.port}/${target.database}") is not an approved Playwright test target.`,
    );
  }

  return { env: { ...parsedTestEnv, DATABASE_URL: databaseUrl }, target };
}

/**
 * Defense in depth for anything about to construct a database client (see
 * e2e/decision-workflow.spec.ts's `getPlaywrightTestPrisma()`) — re-checks
 * `env.DATABASE_URL` immediately before that happens, independent of
 * whatever `resolvePlaywrightTestEnvironment()` decided earlier in this
 * process's lifetime. Never trusts that an earlier check still holds;
 * matches the "revalidate at the point of use" discipline this project
 * uses for actor roles elsewhere. Returns the safe target on success so a
 * caller can log/assert on it without ever handling the raw URL.
 */
export function assertPlaywrightTestDatabaseTarget(env: NodeJS.ProcessEnv): SafeDatabaseTarget {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new PlaywrightTestEnvironmentError(
      "DATABASE_URL is not set — refusing to initialize a database client.",
    );
  }

  const target = sanitizeDatabaseUrl(databaseUrl);
  if (!target) {
    throw new PlaywrightTestEnvironmentError(
      "DATABASE_URL could not be parsed as a URL — refusing to initialize a database client.",
    );
  }

  const approved = findApprovedDatabaseTarget(target, APPROVED_PLAYWRIGHT_TEST_TARGETS, env);
  if (!approved) {
    throw new PlaywrightTestEnvironmentError(
      `Refusing to initialize a database client: "${target.host}:${target.port}/${target.database}" is not an approved Playwright test target.`,
    );
  }

  return target;
}
