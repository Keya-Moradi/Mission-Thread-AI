// Shared safety guard for every destructive database operation in this
// codebase (test-database reset, the seed script's clear-and-reseed step,
// and any future reset/fixture command). Centralizing this logic is what
// makes SPEC.md's test-database-isolation rule actually hold everywhere,
// instead of depending on each script re-implementing its own check.

/**
 * One exact, approved (host, port, database) combination a destructive
 * operation may target. Host, port, and database are matched independently
 * elsewhere in most systems, which is exactly the gap that let
 * `localhost:5432/missionthread_dev` (the wrong port — a developer's other
 * local Postgres, not this project's Docker Compose instance) pass a
 * host-allowlist-plus-database-allowlist check that never looked at the
 * port at all. Matching the whole tuple at once closes that gap.
 */
export interface ApprovedDatabaseTarget {
  host: string;
  port: string;
  database: string;
  /** True only for the CI Postgres service tuple — see requiresCi below. */
  requiresCi?: boolean;
}

/**
 * Local Docker Compose Postgres (docker-compose.yml), host port 55432 —
 * chosen specifically to avoid colliding with a developer's own local
 * Postgres on the standard 5432 (see docs/DECISIONS.md). Both loopback
 * spellings are listed because Node's URL parser treats "localhost" and
 * "127.0.0.1" as distinct hostnames; a connection string using either one
 * resolves to the same container.
 */
export const LOCAL_DEV_TARGETS: readonly ApprovedDatabaseTarget[] = [
  { host: "localhost", port: "55432", database: "missionthread_dev" },
  { host: "127.0.0.1", port: "55432", database: "missionthread_dev" },
];

export const LOCAL_TEST_TARGETS: readonly ApprovedDatabaseTarget[] = [
  { host: "localhost", port: "55432", database: "missionthread_test" },
  { host: "127.0.0.1", port: "55432", database: "missionthread_test" },
];

/**
 * The GitHub Actions `postgres:17-alpine` service container defined in
 * .github/workflows/ci.yml, reachable at the runner's localhost on the
 * standard Postgres port. `requiresCi: true` means this tuple only matches
 * when `CI` is exactly `"true"` — the variable GitHub Actions (and most CI
 * providers) sets automatically — so this specific host/port/database
 * combination can never be satisfied by a developer's own machine, where a
 * stray local Postgres could otherwise happen to be listening on 5432 with
 * a same-named database.
 *
 * Only "localhost" is listed, not "127.0.0.1", because that's what
 * .github/workflows/ci.yml actually configures for DATABASE_URL — adding a
 * second spelling nothing currently uses would be exactly the kind of
 * speculative allowlist entry this design is trying to avoid.
 */
export const CI_TEST_TARGETS: readonly ApprovedDatabaseTarget[] = [
  { host: "localhost", port: "5432", database: "missionthread_test", requiresCi: true },
];

// IPv6 loopback ("::1") is intentionally not an approved host. Node's URL
// parser renders it as the bracketed literal "[::1]" (verified directly:
// `new URL("postgresql://x@[::1]:5432/db").hostname === "[::1]"`), and
// nothing in this project's Docker Compose config, CI workflow, or local
// tooling ever connects over IPv6 — adding untested, unused surface here
// would only widen the guard without a real use case behind it. Add a
// bracketed "[::1]" tuple (not bare "::1", which can never match) if a
// real need appears later.

export function extractDatabaseName(connectionUrl: string): string {
  return new URL(connectionUrl).pathname.replace(/^\//, "");
}

export interface SafeDatabaseTarget {
  host: string;
  port: string;
  database: string;
}

/**
 * Extracts only the metadata that is safe to put in a log line or error
 * message — host, port, database name. Never returns the username,
 * password, or any query-string parameters, and never returns the raw
 * connection string itself. Returns null instead of throwing so callers
 * can treat "unparsable URL" as just another rejection reason.
 *
 * `url.port` is the empty string when a URL omits an explicit port (e.g.
 * relying on Postgres's default 5432); every approved target in this file
 * specifies its port explicitly, so an omitted port never accidentally
 * matches one of them.
 */
export function sanitizeDatabaseUrl(connectionUrl: string): SafeDatabaseTarget | null {
  try {
    const url = new URL(connectionUrl);
    return {
      host: url.hostname || "(unknown host)",
      port: url.port || "(no port specified)",
      database: url.pathname.replace(/^\//, "") || "(unknown database)",
    };
  } catch {
    return null;
  }
}

/**
 * Finds the single approved target tuple matching every field of the given
 * connection metadata exactly, or null if none match. `candidateTargets` is
 * the caller-specific subset of tuples that particular operation may ever
 * target — e.g. the test-reset script only ever passes LOCAL_TEST_TARGETS,
 * never LOCAL_DEV_TARGETS, even though both are globally "approved".
 */
export function findApprovedDatabaseTarget(
  target: SafeDatabaseTarget,
  candidateTargets: readonly ApprovedDatabaseTarget[],
  env: NodeJS.ProcessEnv,
): ApprovedDatabaseTarget | null {
  return (
    candidateTargets.find((candidate) => {
      if (candidate.host !== target.host) return false;
      if (candidate.port !== target.port) return false;
      if (candidate.database !== target.database) return false;
      if (candidate.requiresCi && env.CI !== "true") return false;
      return true;
    }) ?? null
  );
}

// "test" must appear as its own token — bounded by the start/end of the
// name or an underscore/hyphen — not as a mere substring. This is no
// longer the primary authorization mechanism (findApprovedDatabaseTarget's
// exact tuples are), but it remains useful as a fast, human-readable sanity
// check and is kept for any code that wants a cheap "does this look like a
// test database" signal without needing a full target tuple.
const TEST_TOKEN_PATTERN = /(^|[_-])test($|[_-])/i;

export function isTestDatabaseName(databaseName: string): boolean {
  return TEST_TOKEN_PATTERN.test(databaseName);
}

export type DestructiveOperationFailureReason =
  | "production_environment"
  | "missing_database_url"
  | "malformed_database_url"
  | "target_not_approved"
  | "missing_explicit_opt_in";

export interface DestructiveOperationCheck {
  allowed: boolean;
  reason?: DestructiveOperationFailureReason;
  /** Always safe to log or print: never contains credentials or the raw connection string. */
  message: string;
}

export interface DestructiveOperationRequest {
  /** Short label used only in the safe message, e.g. "test database reset". */
  operationName: string;
  databaseUrl: string | undefined;
  /** The exact tuples this specific operation may target — see findApprovedDatabaseTarget. */
  approvedTargets: readonly ApprovedDatabaseTarget[];
  /** Injectable environment for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/** The exact opt-in value required to run a destructive operation. Anything else — "1", "yes", "TRUE" — is treated as not set, so a typo can never accidentally authorize a reset. */
const DESTRUCTIVE_OPERATION_OPT_IN_VALUE = "true";

/**
 * The single guard every destructive database operation must pass before
 * touching data. Fails closed: any ambiguity — missing URL, unparsable URL,
 * a host/port/database combination that isn't an exact approved tuple, or a
 * missing opt-in flag — is a rejection, never a default-allow. Checks run
 * cheapest/most decisive first so a production guard never depends on
 * first successfully parsing a URL that might not even be present.
 *
 * The opt-in flag (ALLOW_DESTRUCTIVE_DATABASE_OPERATION) is deliberately
 * never set in any committed .env example file — it's supplied only by the
 * npm scripts whose names say what they do (db:seed:destructive,
 * db:reset:test), via scripts/with-destructive-auth.mjs, for the lifetime
 * of that one child process. A flag that's "safe to leave enabled" isn't
 * actually authorizing anything; it has to cost something to set.
 */
export function checkDestructiveOperationAllowed(
  request: DestructiveOperationRequest,
): DestructiveOperationCheck {
  const env = request.env ?? process.env;

  // Belt-and-suspenders on top of the target-tuple check below: never run a
  // destructive command in a process that believes it's production,
  // regardless of what its DATABASE_URL happens to look like.
  if (env.NODE_ENV === "production") {
    return {
      allowed: false,
      reason: "production_environment",
      message: `Refusing ${request.operationName}: NODE_ENV is "production".`,
    };
  }

  if (!request.databaseUrl) {
    return {
      allowed: false,
      reason: "missing_database_url",
      message: `Refusing ${request.operationName}: no database URL was provided.`,
    };
  }

  const target = sanitizeDatabaseUrl(request.databaseUrl);
  if (!target) {
    return {
      allowed: false,
      reason: "malformed_database_url",
      message: `Refusing ${request.operationName}: the database URL could not be parsed.`,
    };
  }

  const approved = findApprovedDatabaseTarget(target, request.approvedTargets, env);
  if (!approved) {
    return {
      allowed: false,
      reason: "target_not_approved",
      message: `Refusing ${request.operationName}: "${target.host}:${target.port}/${target.database}" is not an approved target for this operation.`,
    };
  }

  if (env.ALLOW_DESTRUCTIVE_DATABASE_OPERATION !== DESTRUCTIVE_OPERATION_OPT_IN_VALUE) {
    return {
      allowed: false,
      reason: "missing_explicit_opt_in",
      message: `Refusing ${request.operationName}: set ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true to confirm this is intentional.`,
    };
  }

  return {
    allowed: true,
    message: `${request.operationName} approved for "${target.host}:${target.port}/${target.database}".`,
  };
}
