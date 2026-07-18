// Shared safety guard for every destructive database operation in this
// codebase (test-database reset, the seed script's clear-and-reseed of the
// dev database, and any future reset/fixture command). Centralizing this
// logic is what makes SPEC.md's "test reset must refuse to run unless the
// database name clearly contains a test marker" rule actually hold
// everywhere, instead of depending on each script re-implementing its own
// check correctly.

/**
 * Explicit, hand-maintained list of database names this project's
 * destructive commands are ever allowed to touch. A name that merely
 * *looks* like a test database (see isTestDatabaseName) is not enough on
 * its own — it must also be a name this project actually created.
 */
export const APPROVED_TEST_DATABASE_NAMES = ["missionthread_test"] as const;
export const APPROVED_DEV_DATABASE_NAMES = ["missionthread_dev"] as const;

/**
 * Hosts a destructive operation is allowed to target: the local machine,
 * and the Docker Compose service's in-network hostname. There is currently
 * no legitimate reason for a destructive reset in this project to reach any
 * other host, so unlike the other checks this one has no opt-in override —
 * if that ever changes, add the new host here explicitly rather than
 * bypassing the check.
 */
export const APPROVED_LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1", "postgres"] as const;

/** The exact opt-in value required to run a destructive operation. Anything else — "1", "yes", "TRUE" — is treated as not set, so a typo can never accidentally authorize a reset. */
const DESTRUCTIVE_OPERATION_OPT_IN_VALUE = "true";

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
 */
export function sanitizeDatabaseUrl(connectionUrl: string): SafeDatabaseTarget | null {
  try {
    const url = new URL(connectionUrl);
    return {
      host: url.hostname || "(unknown host)",
      port: url.port || "(default port)",
      database: url.pathname.replace(/^\//, "") || "(unknown database)",
    };
  } catch {
    return null;
  }
}

// "test" must appear as its own token — bounded by the start/end of the
// name or an underscore/hyphen — not as a mere substring. Without this,
// names like "contest_prod", "latest", "attestation", and "testament" would
// all satisfy a naive `.includes("test")` check.
const TEST_TOKEN_PATTERN = /(^|[_-])test($|[_-])/i;

export function isTestDatabaseName(databaseName: string): boolean {
  return TEST_TOKEN_PATTERN.test(databaseName);
}

/** True only when a name both looks like a test database and is one this project actually provisions. */
export function isApprovedTestDatabaseName(databaseName: string): boolean {
  return (
    isTestDatabaseName(databaseName) &&
    (APPROVED_TEST_DATABASE_NAMES as readonly string[]).includes(databaseName)
  );
}

export type DestructiveOperationFailureReason =
  | "production_environment"
  | "missing_database_url"
  | "malformed_database_url"
  | "host_not_allowed"
  | "database_name_not_approved"
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
  /** The exact set of database names this specific operation may target. */
  approvedDatabaseNames: readonly string[];
  /** Injectable environment for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * The single guard every destructive database operation must pass before
 * touching data. Fails closed: any ambiguity — missing URL, unparsable URL,
 * an unrecognized host, an unlisted database name, or a missing opt-in flag
 * — is a rejection, never a default-allow. Checks run cheapest/most
 * decisive first so a production guard never depends on first successfully
 * parsing a URL that might not even be present.
 */
export function checkDestructiveOperationAllowed(
  request: DestructiveOperationRequest,
): DestructiveOperationCheck {
  const env = request.env ?? process.env;

  // Belt-and-suspenders on top of the host/name allowlists below: never run
  // a destructive command in a process that believes it's production,
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

  if (!(APPROVED_LOCAL_HOSTS as readonly string[]).includes(target.host)) {
    return {
      allowed: false,
      reason: "host_not_allowed",
      message: `Refusing ${request.operationName}: host "${target.host}" is not an approved local development host.`,
    };
  }

  if (!request.approvedDatabaseNames.includes(target.database)) {
    return {
      allowed: false,
      reason: "database_name_not_approved",
      message: `Refusing ${request.operationName}: database "${target.database}" is not in the approved list for this operation.`,
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
    message: `${request.operationName} approved for database "${target.database}" on host "${target.host}".`,
  };
}
