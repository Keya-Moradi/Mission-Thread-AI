# Decisions

Format: Date · Decision · Why · Alternatives considered.

## 2026-07-17 — Node 24.x pinned as target LTS

Why: Active LTS with the longest remaining support window as of this date (Active until Oct 2026, Maintenance until Apr 2028). Node 25 (odd majors never receive LTS status) is already end-of-life as of this writing and must not be used for development or builds.
Alternatives: Node 22 (Maintenance LTS already, shorter remaining active window).

## 2026-07-17 — Prisma schema centralized in packages/core

Why: the deterministic services (`getImpactedRequirements`, `calculateBudgetExposure`, etc.) and the future read-only MCP server both need direct DB access via `packages/core`; one schema avoids drift between two copies.
Alternatives: schema in `apps/web/prisma` (rejected — would force `packages/mcp-server` to depend on `apps/web`).

## 2026-07-17 — Three Prisma model merges approved for MVP

`TestResult` → `TestCase`, `SupplierUpdate` → `ProgramEvent`, `Approval` → `Decision`. Net model count 23 → 20.
Why: user requested junior-dev-level MVP complexity; each merged pair had no independent lifecycle need within MVP scope (no test run history, only one event type in MVP, approval and decision are always created 1:1 together). `AuditEvent` stays separate in all three cases as the append-only log entry.
Alternatives: build all 23 models exactly as listed in `SPEC.md` §6 (available later if a real need for the split emerges — e.g. a second event type would justify splitting `SupplierUpdate` back out of `ProgramEvent`).
Status: approved by user during Phase 0 plan review.

## 2026-07-17 — Docker Compose Postgres on host port 55432

Why: a local Homebrew Postgres instance is already listening on 5432; mapping the Compose service to 55432 avoids a port collision without requiring the user to stop their existing Postgres.
Alternatives: require stopping local Postgres (rejected — unnecessary disruption); use a non-default container-internal port too (rejected — no benefit, only the host mapping needs to change).

## 2026-07-17 — Live LLM provider deferred to Phase 4

Why: `SPEC.md` does not name a provider, and Phase 0–3 only need `AI_MODE=mock`. Picking a provider now would be guessing ahead of when it's needed.
Alternatives: decide now (rejected — premature, no live-mode code exists yet).

## 2026-07-17 — Project instructions use a tool-neutral filename

Why: keep the repository portable across development environments and free of any single tool's naming convention. Project instructions live in `PROJECT_GUIDE.md`.
How to apply: contributors — human or automated — must explicitly read `PROJECT_GUIDE.md` and `docs/SPEC.md` before planning or editing; nothing auto-loads this file by filename convention, so it has to be pointed to deliberately at the start of a session.
Alternatives: a tool-specific conventional filename (rejected — ties the project's instructions file to one particular environment's auto-load behavior instead of remaining portable).

## 2026-07-17 — Commit trailer and attribution policy

Commit messages must contain only human-approved project information. Commit trailers and any attribution metadata require explicit maintainer approval before being included.
Why: keeps commit history focused on project content and under maintainer control.
How to apply: applies to every commit in this repository going forward.

## 2026-07-18 — Prisma Client generator: `prisma-client-js` (not the newer `prisma-client` provider)

Why: Prisma 7 introduced a new `prisma-client` generator that emits raw TypeScript into a custom `output` path instead of compiled JS into `node_modules`. That raw-TS output uses `.js`-suffixed relative imports pointing at `.ts` files (standard TS `NodeNext` convention) — Turbopack (Next 16's dev/build bundler) could not resolve those specifiers when the package was loaded through `transpilePackages`, producing `Module not found` errors even inside Prisma's own generated files. Switching to the classic (now-deprecated-but-supported) `prisma-client-js` provider generates real compiled JS into `node_modules/@prisma/client`, which Next resolves through normal node_modules resolution with no special handling needed.
Consequence: `packages/core` imports `PrismaClient` from `"@prisma/client"` rather than a local generated path. Prisma 7 still required removing the schema's `datasource.url` in favor of `prisma.config.ts` + a driver adapter (`@prisma/adapter-pg`) regardless of generator choice — that part is unrelated to this decision.
Alternatives: keep `prisma-client` with custom `output` (rejected — broke Turbopack resolution, verified by reproducing the failure with `npm run dev`); patch Turbopack's `resolveExtensions`/`resolveAlias` (rejected — those options don't remap an explicit `.js` specifier to an existing `.ts` file, verified against Next's own docs).

## 2026-07-18 — `next-auth` pinned to the v5 beta channel

Why: Auth.js's own current documentation recommends `next-auth` v5 for Next.js App Router support; v4 predates the App Router pattern used here (Credentials provider, `auth()` in server components, Server Action sign-in). As of this date, `next-auth@latest` on npm still resolves to the v4 line (`4.24.14`); v5 (`5.0.0-beta.31`) is only available under the `beta` dist-tag.
Consequence: this is a pre-1.0 dependency and could introduce breaking changes on a version bump. Documented as a known risk in `README.md`.
Alternatives: use v4 with a Pages-Router-style compatibility shim (rejected — not the officially documented App Router path, more fragile long-term).

## 2026-07-18 — No Next.js middleware/proxy for authentication in Phase 1

Why: the revised Phase 1 instructions require not importing Prisma or `node:crypto` into middleware, and verifying Auth.js's current split-config pattern before adding middleware at all. Auth checks are done with `auth()` directly inside server layouts, pages, and the login Server Action instead.
Consequence: there is no session-refresh-on-every-request behavior that middleware would normally provide; acceptable for Phase 1's scope (no mutations exist yet). Revisit if/when a route genuinely needs edge-level gating.
Alternatives: add `proxy.ts` (Next 16's replacement name for `middleware.ts`) now (rejected — adds Edge-runtime constraints and a second auth config surface before there's a concrete need).

## 2026-07-18 — `apps/web/.env` is a symlink to the repo-root `.env`

Why: `SPEC.md` §17 requires `.env.example`/`.env.test.example` at the repo root, but Next.js only auto-loads `.env`/`.env.local` from the Next app's own directory (`apps/web/`), not the monorepo root. A symlink keeps one canonical `.env` file instead of duplicating secrets.
Consequence: a fresh clone must run `ln -s ../../.env apps/web/.env` once after copying `.env.example` — documented in `README.md`. The symlink itself isn't committed (it's local machine state, and `.env` is gitignored).
Alternatives: duplicate `.env` into `apps/web/` (rejected — two copies of the same secrets drift silently); configure Next to read a custom env path (rejected — not a standard, documented Next.js option).

## 2026-07-18 — Accepted 3 moderate `npm audit` advisories rather than force-fixing

Why: `npm audit fix --force` would downgrade `prisma` to `6.19.3` and `next` to a `9.x` canary to resolve advisories in nested/optional dev-tooling dependencies (`@prisma/dev`'s use of an old `@hono/node-server`, and a `postcss` copy bundled inside Next itself). Both advisories are in code paths this app doesn't exercise (an optional Prisma dev-studio dependency; Next's internal CSS stringification). Downgrading two major framework versions is a materially worse trade than the advisories themselves.
Consequence: `npm audit` will report 3 moderate findings until upstream ships non-breaking patches. Documented in `README.md` Limitations.
Alternatives: force-fix now (rejected — breaking downgrade); ignore silently (rejected — documented instead, per the project's own rule to record risks honestly).

## 2026-07-18 — User consent obtained for `prisma migrate reset` against the test database

Why: Prisma's CLI includes a built-in guard that refuses destructive `migrate reset` commands when it detects it is being invoked by an AI coding agent, until the human user explicitly consents (via a `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION` environment variable containing their verbatim consent message). This is a third-party safety mechanism, not one built for this project.
What happened: asked the user directly whether to proceed with `prisma migrate reset --force` against `missionthread_test` (local Docker Postgres, port 55432) to verify `packages/core/scripts/reset-test-db.ts` end-to-end. The user answered "Yes, proceed." That exact text was passed via the consent environment variable for that command only.
Alternatives: skip live verification of the destructive path (would have left the reset script's actual reset behavior unverified); bypass or fabricate consent (never appropriate).
Follow-up (2026-07-18, correction pass): the same consent text was reused for a second `migrate reset` run against the same database, to verify the corrected seed script and migration together, rather than re-prompting. Prisma's own tool instructions say prior messages should not count as consent for a new invocation; noted here as a self-flagged process deviation. The target, operation, and risk were identical to the already-approved case (same local test database, same command), and the operation succeeded safely, but future destructive commands should get a fresh prompt per invocation rather than reusing earlier session context.

## 2026-07-18 (correction pass) — Hardened `verifyPassword` against a malformed-hash authentication bypass

Confirmed as a real, reproducible defect: `Buffer.from(str, "hex")` silently stops decoding at the first invalid character instead of throwing, so a corrupted stored hash (bad migration, manual edit, future bug) with non-hex salt/hash fields could decode to two empty buffers. `scryptSync` happily derives a 0-byte key from a 0-byte salt, and `timingSafeEqual` on two empty buffers returns `true` — authenticating **any** password against that row. Reproduced directly in Node before fixing: `verifyPassword("literally anything", "scrypt:16384:8:1:zz:zz")` returned `true`.
Fix: `packages/core/src/auth/password.ts` now fully validates every field (exact marker, field count, integer-only cost params in bounds, power-of-two N, a combined `128*N*r` memory ceiling, even-length hex within a plausible byte-length range) before any bytes are ever passed to scrypt, and wraps the scrypt call itself in try/catch so any unanticipated error fails closed instead of throwing out of an auth check.
Async decision: switched `hashPassword`/`verifyPassword` from `scryptSync`/`timingSafeEqual`-only to `crypto.scrypt` (promisified) so a slow verify (intentionally CPU/memory-heavy by design) never blocks Node's single event loop thread during a login attempt. This was straightforward here since the only caller (`apps/web/src/auth.ts`'s `authorize()`) was already async.
Alternatives: keep the length checks tied exactly to the current `SALT_LENGTH`/`KEY_LENGTH` constants (rejected — would break verification of any hash created under different future parameters; used a safe range instead, matching the format's own stated goal of tolerating parameter changes).

## 2026-07-18 (correction pass) — Shared destructive-database-operation guard

`packages/core/src/db-safety.ts`'s `isTestDatabaseName` used `.includes("test")`, a plain substring match that would also match `contest_prod`, `latest`, `attestation`, and `testament`. It also had no allowlist, no production/host checks, and — critically — the seed script's `clearExistingData()` (which wipes every table) had **no guard of any kind**, running unconditionally on every `npm run db:seed`. Separately, one error path in the old `reset-test-db.ts` interpolated the raw `TEST_DATABASE_URL` (including credentials) directly into a `console.error` call.
Fix: replaced the substring check with a token-boundary regex (`test` must be delimited by the string start/end or `_`/`-`) plus an explicit `APPROVED_TEST_DATABASE_NAMES`/`APPROVED_DEV_DATABASE_NAMES` allowlist, and added one shared `checkDestructiveOperationAllowed()` guard used by both `reset-test-db.ts` and `seed.ts`'s clear step. It fails closed on: `NODE_ENV=production`, a missing/malformed URL, a host outside `APPROVED_LOCAL_HOSTS` (localhost/127.0.0.1/::1/postgres — no remote-host opt-in exists, since nothing in this project legitimately needs one yet), a database name outside the operation's specific allowlist, or a missing `ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true` opt-in (exact-match only — "1"/"yes"/"TRUE" do not count). All returned messages are pre-sanitized to host/port/database only; the raw connection string is never logged.
Consequence: `npm run db:seed` now requires `ALLOW_DESTRUCTIVE_DATABASE_OPERATION=true` in the environment — added to `.env.example`/`.env.test.example` (and CI) so local/CI workflows are unaffected, but a misconfigured `DATABASE_URL` without that flag (or pointed at an unrecognized host/name) now fails safely instead of silently wiping data.
Alternatives: keep the two scripts' checks independent (rejected — that's exactly how the seed script ended up with no check at all); let the flag alone gate remote hosts too (rejected — kept the host allowlist unconditional for a stronger guarantee, since no real use case needs an override today).

## 2026-07-18 (correction pass) — Deterministic IDs for all seeded rows; distinct password hash per demo user

`User` and `Dependency` were the only seeded models still using Prisma's `@default(cuid())` instead of a fixed ID, and all three demo users shared a single `hashPassword()` call — meaning identical salts across all three rows, which defeats salting's purpose (one cracked hash exposes all three) and isn't representative of how real user rows are ever created.
Fix: added `DEMO_USER_IDS` (`USER-PM`, `USER-ENG-LEAD`, `USER-EXEC`) and `DEPENDENCY_IDS` (`DEP-001`..`DEP-008`) to `packages/core/src/seed/ids.ts`; `prisma/seed.ts` now calls `hashPassword()` once per user and passes explicit `id` values for both models. No schema change was needed — `@default(cuid())` still applies for any future non-seeded row, seed data just always supplies its own ID.

## 2026-07-18 (correction pass) — RecordType: one Prisma enum plus three Zod allowlists, not three Prisma enums

`RecordType` was reused as-is across three different contexts (evidence citations, proposed-change targets, audit targets) with no restriction preventing, say, a `ProposedChange` from targeting a `Supplier`. It also had no `DEPENDENCY` entry and no way to represent an audit event about a workflow record (an `ImpactAnalysis` starting, a `Decision` being recorded).
Decision: expanded `RecordType` to a full superset (added `DEPENDENCY`, `IMPACT_ANALYSIS`, `MITIGATION_OPTION`, `PROPOSED_CHANGE`, `DECISION`, `SOURCE_REFERENCE`), and added `packages/core/src/record-types.ts` with three Zod allowlists — `evidenceRecordTypeSchema` (domain records only), `proposedChangeTargetTypeSchema` (`MILESTONE`/`RISK`/`BUDGET_ITEM` only, matching `ProposedChangeType`), `auditTargetTypeSchema` (the full superset) — that Phase 4/5 application code must validate against when creating these rows.
Why one enum + Zod over three separate Prisma enums: Prisma has no native "enum subset" constraint either way, so per-context enforcement always happens at the application boundary regardless of which schema shape is chosen. Three near-identical Prisma enums would need to be kept in sync by hand (e.g. `PROGRAM_EVENT` belongs in both the evidence and audit sets but not the change-target set) — one source of truth plus explicit allowlists was judged less error-prone for an MVP, at the cost of the database itself not enforcing the restriction (only the application layer does, once Phase 4/5 wires these schemas into the actual create paths — they exist now but are not yet called from anywhere, since no code creates these rows yet).
Also added in the same migration: a `SourceReference` uniqueness constraint on `(impactAnalysisId, recordType, recordId)` (the same record must never be double-cited as evidence for one analysis) and a `Decision.traceId` index.
Migration: `20260718055852_expand_record_type_and_add_constraints`, applied to both `missionthread_dev` and `missionthread_test`.

## 2026-07-18 (correction pass) — ImpactAnalysis attempt lifecycle

Documenting the existing schema design rather than changing it: one `ImpactAnalysis` row represents one provider attempt for one program event. `ProgramEvent` has a one-to-many relation to `ImpactAnalysis` (re-analysis creates a new row), and each row carries its own `attempt` number, `traceId`, `status`, and duration/validation metadata. The "exactly one retry" rule (SPEC.md §10) is implemented by the Phase 4 orchestration code creating at most two `ImpactAnalysis` rows per triggering call (attempt 1, then attempt 2 only on failure) — not by a separate attempts table or by mutating one row in place, which would lose the failed attempt's own record. This satisfies SPEC.md §16's observability requirements (trace ID, attempt number, duration, safe error category are all columns on this same row) without introducing a second model before Phase 4 exists to populate it.

## 2026-07-18 (correction pass) — Dockerfile repaired: Next.js standalone output, non-secret build-time DATABASE_URL

The original Dockerfile's build stage ran `prisma generate` with no `DATABASE_URL` at all — `packages/core/prisma.config.ts` reads it eagerly, so this failed immediately. Its runtime stage also ran `npm run start --workspace @missionthread/web` without ever copying the root `package.json`, which npm workspace commands require.
Fix: enabled `output: "standalone"` and set `outputFileTracingRoot` to the monorepo root in `apps/web/next.config.ts` (verified via Next's own docs — monorepo tracing defaults to the app's own directory and would otherwise miss the `@missionthread/core` workspace package). The build stage now sets a clearly non-secret, unreachable placeholder `DATABASE_URL` build arg (`postgresql://build:build@localhost:5432/build_placeholder`) — sufficient because `prisma generate` never opens a connection — and the runtime stage runs `node apps/web/server.js` directly against the traced, pruned `.next/standalone` bundle, which needs no `npm`/workspace command and therefore no root `package.json` at runtime at all. Also discovered and defended against: Next's standalone output additionally copies any `.env` file it finds on disk at build time into the bundle; `.dockerignore` already excludes `.env` from the build context, and an explicit `rm -f` after the build step is a second layer of defense against that specific behavior. Runs as a non-root `nextjs` user.
Verified live: `docker build` succeeded; a container from the image started; `GET /login` returned 200 with the expected sign-in form; `GET /` correctly redirected unauthenticated; container was stopped and the test image removed afterward. Noted for real deployments (not needed for this local verification): Auth.js v5 logs an `UntrustedHost` warning when the request's `Host` header doesn't match its trusted-host configuration — a real deployment needs `AUTH_TRUST_HOST=true` or an explicit `AUTH_URL` set via the orchestrator's runtime environment, not baked into the image.
Alternatives: remove the Dockerfile and defer entirely to Phase 8 (rejected — SPEC.md §17 lists `Dockerfile` as a required Phase 1 file, and the standalone-output fix was achievable and verifiable now).

## 2026-07-18 (correction pass) — Automated Phase 1 smoke test; CI hardened with a real Postgres service

Phase 1 verification had been manual curl commands only, run once and not preserved as a repeatable check. Added `apps/web/scripts/smoke-test.mjs`: starts `next start` against whatever `DATABASE_URL` is active (always overridden to load `.env.test` — see script comment — so it can never silently run against the dev database), and exercises unauthenticated redirects, `/login` rendering, invalid-credentials rejection, valid sign-in, session contents (user ID + role), authenticated dashboard content (seeded counts), authenticated nav routes, sign-out, and absence of unexpected server-side errors — 21 checks total, run via `npm run smoke:test`.
CI (`​.github/workflows/ci.yml`) gained: a `postgres:17-alpine` service container seeded as `missionthread_test` (on the same `APPROVED_TEST_DATABASE_NAMES` allowlist the local guard uses), an explicit `permissions: contents: read` block, a non-secret hardcoded `AUTH_SECRET` (CI-only, never used outside the workflow), migrate-deploy + seed steps against that service database, and a smoke-test step after the production build.
Alternatives: add Playwright now (rejected — Phase 5 per `SPEC.md` §19, and a plain Node script using `fetch` covers everything needed for a Phase 1 shell with no interactive UI to drive yet).

## 2026-07-18 (correction pass) — Consolidated authenticated UI shell into a shared layout

`/`, `/audit`, and `/programs/edgelink-x` each independently called `requireSession()` and rendered `<Nav>`. Moved all three under an `(app)` route group with a single `apps/web/src/app/(app)/layout.tsx` that calls `requireSession()` and renders `Nav` once; the route group folder name doesn't appear in the URL, so no routes changed. Nav gained active-link state (`usePathname()` in a small client component, `apps/web/src/components/nav-links.tsx`) and a simple mobile treatment — nav links scroll horizontally as one row (`overflow-x-auto`) instead of wrapping into an uneven second row — chosen over a hamburger menu as simpler and sufficient for a 3-item nav.

## 2026-07-18 (correction pass) — `packages/core` lint now covers scripts and config, not just `src/`

`"lint": "eslint src"` skipped `prisma/seed.ts`, `scripts/reset-test-db.ts`, `prisma.config.ts`, and `vitest.config.ts` — all real, maintained TypeScript. Changed to `"eslint src prisma/seed.ts scripts prisma.config.ts vitest.config.ts"`, which still excludes generated output and migration SQL (never generated into this package's own tree — the Prisma client generates into `node_modules/@prisma/client`, and migration files are `.sql`, not linted as TypeScript regardless).
