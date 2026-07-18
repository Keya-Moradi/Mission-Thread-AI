# Decisions

Format: Date · Decision · Why · Alternatives considered.

## 2026-07-17 — Node 24.x pinned as target LTS

Why: Active LTS with the longest remaining support window as of this date (Active until Oct 2026, Maintenance until Apr 2028); the local machine's v25 is a Current/non-LTS line and shouldn't be the pin.
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

## 2026-07-17 — Project-instructions file renamed to PROJECT_GUIDE.md

Why: user wants the repository free of references to which coding assistant was used, for portfolio neutrality. The file previously used a filename that some AI coding tools auto-load by convention, which itself named the tool.
Consequence: because that convention is filename-based auto-loading, a fresh AI coding session will not automatically read this file anymore — a session must be explicitly told to read `PROJECT_GUIDE.md` and `docs/SPEC.md` before planning or editing (the file's own first line already says this, but nothing auto-triggers reading it).
Alternatives: keep the original filename (rejected — reveals tooling by filename convention).

## 2026-07-17 — No AI co-author trailers on commits

Why: user does not want commit history to reveal which AI coding assistant was used. The initial Phase 0 commit was amended (`git commit --amend`) to strip an AI co-author trailer before anyone else could branch from it, then force-pushed with `--force-with-lease`.
How to apply: all future commits in this repository omit AI-assistant co-author trailers, generated-by notices, or tool attribution, in commit messages, code, comments, and documentation.
Alternatives: leave trailer in history (rejected — explicit user request); rewrite deeper history (not needed — only one commit existed).

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
