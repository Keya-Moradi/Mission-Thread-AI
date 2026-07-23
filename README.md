![MissionThread AI — Auditable AI-Assisted Program Digital Thread](docs/assets/missionthread-ai-banner.png)

# MissionThread AI

An auditable, AI-assisted program digital-thread platform for complex
hardware-and-software delivery programs. It connects requirements,
schedules, costs, risks, testing, logistics, suppliers, and field feedback,
and uses AI to identify cross-program impacts and propose evidence-backed
mitigation options — while keeping human approval, traceability, and source
attribution mandatory at every step.

**All program, supplier, and personnel data in this repository is fictional,
synthetic, and unclassified.** Nothing here references a real employer,
program, customer, classified system, or export-controlled detail.

## Project status

**Phase 5 of 8 (Approval and audit) — complete.** Workspaces, database
schema, deterministic seed data, authentication, the full deterministic
program-analysis service layer (`packages/core/src/analysis`), a real
database-driven dashboard/program overview/event-entry form/audit shell,
a full AI impact-analysis pipeline (`packages/core/src/ai`), and now the
complete human approval/apply workflow (`packages/core/src/approvals`) all
exist and are verified working. A Program Manager can record a
supplier-delay or general-update event, trigger an impact analysis on it,
and — once it succeeds — record a decision (approve with structured
proposed changes, reject, or request revision) on each of the three
mitigation options; an Engineering Lead may request revision. An approval
is reviewed on a read-only apply-preview page (old vs. proposed values,
stale-data warnings) before a Program Manager types an exact confirmation
and applies it, transactionally and atomically, to the real milestone,
risk, or budget data — every step producing an append-only audit record.
See [Phase roadmap](#phase-roadmap) and [Limitations](#limitations) below.

Development follows a phase-gated process defined in
[`PROJECT_GUIDE.md`](PROJECT_GUIDE.md) and [`docs/SPEC.md`](docs/SPEC.md):
one phase is authorized and built at a time, each with its own quality gate.
[`docs/TASKS.md`](docs/TASKS.md) tracks detailed, resumable status, and
[`docs/DECISIONS.md`](docs/DECISIONS.md) records why non-obvious choices were
made.

## Protected workflow spine

The MVP is built around one protected end-to-end path, in this order of
priority (see `docs/SPEC.md` §18 for the full cut list if scope needs to
shrink):

```
event → deterministic analysis → bounded AI interpretation →
three mitigation options → approval → apply preview → audit
```

Every normal calculation (schedule exposure, budget exposure, risk scoring,
readiness) is deterministic code, never an LLM guess. The AI layer only
explains evidence and proposes options — it can never mutate program data,
approve anything, or apply a change. Every mutation past that point is a
real, revalidated human action: only a Program Manager (or, for revision
requests, an Engineering Lead) can record a decision, and only a Program
Manager can apply one, after typing an exact confirmation on a page that
states nothing has been applied yet.

## Architecture

npm workspaces monorepo:

```
apps/web              Next.js App Router UI, route handlers, server actions
                        (dashboard, program overview, event entry, audit — Phase 3, done;
                        analysis trigger, analysis workspace, readiness briefing — Phase 4, done;
                        decision page, apply-preview page, Actions section — Phase 5, done)
packages/core          Zod schemas, deterministic services (Phase 2, done),
                        event-entry contract + recordProgramEvent (Phase 3, done),
                        AI provider abstraction + mock/live providers + orchestration
                        (packages/core/src/ai — Phase 4, done),
                        approval/apply workflow (packages/core/src/approvals — Phase 5, done),
                        Prisma schema/client
packages/mcp-server     Read-only MCP server (placeholder — built in Phase 7)
docs/                   Spec, plans, tasks, decisions, architecture, threat model
evals/                  AI pipeline evaluations (Phase 6)
```

Prisma's schema is centralized in `packages/core/prisma` — both `apps/web`
and the future `packages/mcp-server` read the database only through
`packages/core`, so there is a single source of truth for the data model.

Full request/data flow and the Prisma domain model are documented in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Technology stack

- Next.js (App Router) + React + TypeScript (strict mode)
- PostgreSQL + Prisma ORM (driver adapter: `@prisma/adapter-pg`)
- Auth.js v5 (Credentials provider, JWT sessions)
- Zod for all external input/output validation
- Tailwind CSS
- Vitest (unit/integration tests); Playwright (`apps/web/e2e`, one happy-path test)
- Docker Compose (local Postgres); GitHub Actions (CI)
- Structured JSON logging (`packages/core/src/ai/logging.ts`)
- `openai` npm package (Responses API, live AI mode only)

## Prerequisites

- [nvm](https://github.com/nvm-sh/nvm) (or another way to get exactly Node 24.x)
- Docker Desktop (or another Docker Compose–compatible runtime)
- npm (ships with Node)

## Node version

This project pins **Node 24.x** (Active LTS). The exact patch is recorded in
[`.nvmrc`](.nvmrc).

> Node 25 is an odd-numbered major that never received LTS and is now EOL;
> this project targets Node 24 (Active LTS). Don't develop or build against
> Node 25 even if it happens to be your system default.

```bash
nvm install
nvm use
```

## Installation

```bash
git clone <this-repo>
cd Mission-Thread-AI
nvm use
npm install
```

## Environment configuration

Environment files live at the **repo root**, not per-package.

```bash
cp .env.example .env
cp .env.test.example .env.test
```

Generate a real `AUTH_SECRET` for `.env` locally (the example file ships
with a placeholder):

```bash
npx auth secret
```

`apps/web` (Next.js) only reads `.env`/`.env.local` from its own directory,
so link the root file into place once:

```bash
ln -s ../../.env apps/web/.env
```

`AI_MODE` must be exactly `mock` or `live` (see `.env.example`). Local
development and CI both use `mock`, which needs no API key. `live` requires
`OPENAI_API_KEY` and `OPENAI_MODEL` (never hardcoded — see
`packages/core/src/ai/openai-provider.ts`); no example file ships a real
key, and no automated test, smoke check, or CI step ever calls the live
provider.

## Database (Docker Compose, port 55432)

The Postgres container is mapped to **host port 55432**, not 5432 — this
avoids colliding with a Postgres you might already have running locally
(see `docs/DECISIONS.md`). One container hosts two logical databases:
`missionthread_dev` and `missionthread_test`.

Safe, non-destructive setup and validation:

```bash
npm run db:up          # start Postgres (docker compose up -d postgres)
npm run db:generate    # generate the Prisma client
npm run db:validate    # validate the Prisma schema
npm run db:migrate     # apply migrations to missionthread_dev
```

**Seeding is destructive** — it clears every row in the target database
before recreating the deterministic fixtures, so it requires a
deliberately named, target-specific command rather than a plain `db:seed`:

```bash
npm run db:seed:dev:destructive  # clears and reseeds missionthread_dev — nothing else
```

This works via a shared guard (`packages/core/src/db-safety.ts`) that only
authorizes an exact, approved `(host, port, database)` target — never a
name that merely _looks_ right — for an explicitly declared scope (`dev`
here), and only for the one child process this command spawns; see
`.env.example` for why the authorization flag itself is never checked into
any example file. The scope is never inferred from `DATABASE_URL`: a
`dev`-scoped run can't touch the test database even if `DATABASE_URL`
were ever misconfigured to point at it, and vice versa.

### Test database

Integration tests must never run against the dev database. The reset
script only authorizes an exact approved local test target
(`localhost:55432/missionthread_test` or `127.0.0.1:55432/missionthread_test`)
— not merely a database name containing "test":

```bash
npm run db:reset:test  # drops, re-migrates, and reseeds missionthread_test only
```

CI uses a third, separate command (`db:seed:github-actions:internal`) that
only authorizes the GitHub Actions service database and only runs inside
an actual GitHub Actions job — it's not a normal local-development command
and shouldn't be run by hand.

## Running the app

```bash
npm run dev
```

Visit `http://localhost:3000` — you'll be redirected to `/login`.

### Demo accounts

Seeded by `npm run db:seed:dev:destructive`, one per role. The password below is a fixed,
publicly documented **local-development-only** credential, not a real
secret — it authenticates against your own local database only.

| Email                        | Role             |
| ---------------------------- | ---------------- |
| `pm@missionthread.example`   | Program Manager  |
| `lead@missionthread.example` | Engineering Lead |
| `exec@missionthread.example` | Executive Viewer |

Password for all three: `MissionThread-Demo-2026!`

## Docker

Build the application image:

```bash
docker build -t missionthread-ai .
```

`prisma generate` runs during the build with a non-secret, unreachable
placeholder `DATABASE_URL` (it never opens a connection at build time —
see the Dockerfile's comment); the real database configuration is supplied
entirely at container **runtime**, via `docker run`'s `-e` flags or your
deployment platform's environment configuration, never baked into the
image.

A container cannot reach the host's Docker Compose Postgres through its
own `localhost` — that would resolve inside the container, not on your
machine. Use Docker Desktop's `host.docker.internal` address instead:

```bash
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgresql://missionthread:missionthread_local_dev_password@host.docker.internal:55432/missionthread_dev" \
  -e AUTH_SECRET="<generate one with: npx auth secret>" \
  -e AUTH_TRUST_HOST=true \
  -e AI_MODE=mock \
  missionthread-ai
```

Required runtime variables: `DATABASE_URL`, `AUTH_SECRET`, `AI_MODE=mock`,
and `AUTH_TRUST_HOST=true` (or an explicit `AUTH_URL`) — Auth.js v5 rejects
requests with an untrusted `Host` header by default, which a container
behind a mapped port will otherwise trigger. Visit `http://localhost:3000/login`
once the container is up.

`docker-compose.yml` currently defines only the Postgres service, not an
application container — the command above talks to that same Compose
Postgres instance from outside Docker's internal network.

## Quality gate commands

```bash
npm run lint          # ESLint across all workspaces
npm run format:check  # Prettier check
npm run format         # Prettier write
npm run typecheck     # tsc --noEmit across all workspaces
npm run test           # Vitest unit tests (packages/core)
npm run build           # production build of apps/web
npm run smoke:test     # build + automated end-to-end smoke test
npm run test:e2e       # build + Playwright happy-path test (resets missionthread_test first)
```

`smoke:test` builds the production app, then runs
`apps/web/scripts/smoke-test.mjs` against it, always pointed at the
dedicated test database (loaded from `.env.test`, never the dev database —
see the script's own comment for why). It exercises the full auth flow:
unauthenticated redirects to `/login` (verifying both the redirect status
and the actual destination), invalid credentials failing safely, valid
seeded credentials authenticating, session contents (user ID and role),
the authenticated dashboard rendering real seeded data, protected nav
routes, role-based approval-workflow controls (against small, cleaned-up
test fixtures), and sign-out actually invalidating the session — run
against the dedicated test database, never the dev database. It never
submits a decision or apply form (no destructive application). The exact
number of checks isn't documented here since it isn't maintained from one
authoritative source; read `apps/web/scripts/smoke-test.mjs` for the
current, complete list.

`test:e2e` resets and reseeds `missionthread_test` (via the same
`db:reset:test` command above, run automatically by Playwright's global
setup), then drives a real Chromium browser through the one true
end-to-end path this repository has: sign in, approve a mitigation option
with a proposed change, review the apply preview, type the exact `APPLY`
confirmation, apply it, and verify the change actually took effect and is
fully audited. Not wired into CI yet — see `apps/web/e2e/` and
`docs/DECISIONS.md`.

All of the above except `test:e2e` are run in CI (`.github/workflows/ci.yml`)
with `AI_MODE=mock`, so the pipeline never needs a live model API key.

## Current routes and functionality (Phase 5)

- `/login` — Credentials sign-in (Zod-validated, scrypt + `timingSafeEqual`
  password verification, JWT session).
- `/` — Executive dashboard: readiness score with factor breakdown,
  requirement/verification-gap/milestone/risk/defect counts, budget
  planned/actual/variance, latest supplier-delay schedule exposure, and
  recent events — all from the Phase 2 deterministic services and real
  Postgres data. A failed calculation shows an explicit "unavailable"
  state, never an invented `0`.
- `/programs/edgelink-x` — full program overview: components, requirements
  with component traceability and verification-gap status, milestones,
  dependency relationships, risk register, test outcomes, open defects,
  budget items and variance, suppliers, and recent events (submitted
  supplier notes are clearly labeled as untrusted content and rendered as
  plain text, never HTML).
- `/programs/edgelink-x/events/new` — **Program Manager only.** Records a
  `SUPPLIER_DELAY` or `GENERAL_UPDATE` event. Server-side validated,
  authorized, and written transactionally with a matching `EVENT_RECORDED`
  audit entry — see "Security and authorization" below. A non-manager is
  redirected away before the form renders, and the underlying mutation
  independently rejects a non-manager role regardless.
- `/audit` — read-only, filterable audit history (action, actor type,
  target type, trace ID — each validated against a fixed allowlist),
  newest first, capped at 50 rows.
- `/programs/edgelink-x/analyses/[id]` — analysis workspace for one
  analysis run (`[id]` is the logical `analysisRunId`, shared by an
  attempt and its one retry). All authenticated roles may view: run
  status, every attempt's number/status/trace ID/provider/model/duration,
  event facts, deterministic schedule/budget exposure, a persisted
  readiness snapshot from when the attempt ran, verification gaps,
  assumptions, unknowns, **the complete evidence supplied to the
  attempt** — every record its model input contained, each marked cited
  (with context) or supplied-only, not just the subset the model chose to
  cite — executive summary, mission impact, and — on success — exactly
  three mitigation options with the recommended one clearly marked.
  **Program Manager only:** triggering a new analysis, via an "Analyze"
  control on the program overview's Recent Events section.
- `/programs/edgelink-x/briefings/[id]` — read-only, printable readiness
  briefing for a successfully completed analysis run. Shows the trace ID,
  confidence, assumptions, unknowns, schedule/budget exposure, the same
  persisted (never recalculated) readiness snapshot, key verification
  gaps, cited relevant risks, the three mitigation options and the
  recommendation, and cited source references — explicit throughout that
  the options are proposals pending human review, never an approved or
  applied change. A pending or failed run shows a safe "briefing
  unavailable" state instead of a fabricated completed view. Each
  mitigation option now also shows its current decision status and, once
  decided, the actor/time/rationale.
- `/programs/edgelink-x/analyses/[id]/options/[optionId]/decision` — record
  a decision on one `PENDING` mitigation option. **Program Manager:**
  approve (with a structured proposed-change editor — add/remove
  milestone-date/risk-update/budget-update/new-action sections, never a
  free-form JSON textarea), reject, or request revision. **Engineering
  Lead:** request revision only. **Executive Viewer:** read-only, no
  controls shown. Once decided, the page shows the decision on record
  instead of a form — a mitigation option accepts at most one decision,
  enforced by the database.
- `/programs/edgelink-x/analyses/[id]/options/[optionId]/apply` — read-only
  apply preview for an approved option, viewable by every role: decision
  rationale and trace ID, every proposed change's target/captured-old/
  proposed-new value, and a stale-data warning if the underlying record
  changed since approval. Explicitly states nothing has been applied yet.
  **Program Manager only:** an apply control that requires typing the
  exact confirmation string before it activates; applies every proposed
  change transactionally and atomically, or none at all.
- `/programs/edgelink-x` — the program overview above also gained an
  "Actions" section listing every applied `NEW_ACTION` proposed change
  (title, description, due date, applied date) — the applied
  `ProposedChange` row itself is the durable record for this MVP; there is
  no separate action-tracking table.

Every decision and apply action produces its own append-only audit
record (`DECISION_RECORDED`, `CHANGES_APPLIED`), visible on `/audit`.

## Security and authorization

- Passwords are hashed with Node's `crypto.scrypt` (OWASP-recommended
  parameters) and verified with `crypto.timingSafeEqual`; see
  `packages/core/src/auth/password.ts`.
- Sessions use Auth.js v5 with the **JWT** strategy explicitly (no database
  session/Account/VerificationToken models — unnecessary for a
  Credentials-only setup).
- All input to the Credentials provider is validated with Zod before it
  touches the database.
- Authorization is enforced server-side on every mutation
  (`recordProgramEvent()`, `runImpactAnalysis()`, `recordMitigationDecision()`,
  `applyApprovedChanges()`): each independently re-fetches the actor's
  current role from the database on every call, never trusting a
  session/JWT claim that could be stale. UI role-gating (hiding the
  "Record event" link, redirecting a non-manager away from the event-entry
  page, hiding approve/reject/apply controls) is a convenience only, never
  treated as sufficient on its own — see `docs/DECISIONS.md`, "Mutation
  authorization" and "Phase 5 decision permissions." No Next.js
  middleware/proxy is used for auth in this phase — `auth()` is called
  directly in server layouts and pages, which keeps Prisma and
  `node:crypto` out of the Edge runtime entirely.
- Applying approved changes requires an exact, explicit confirmation string
  typed into a real form field — never a hidden Boolean the server would
  otherwise have no way to distinguish from an unattended default — and is
  atomic and all-or-nothing: a single stale or invalid proposed change
  blocks the entire batch, never a partial apply.

## Mock vs. live AI

An `LLMProvider` interface (`packages/core/src/ai/provider.ts`) with two
implementations:

- **Mock** (`AI_MODE=mock`, default for local dev and CI) — deterministic,
  no API key, no network. `generateMockImpactAnalysis()` is a pure function
  of the bounded model-input projection: identical input always produces
  identical output, exactly three mitigation options with exactly one
  recommended, and never an invented date, dollar amount, or record ID —
  every citation comes from the supplied evidence allowlist, every
  monetary/schedule figure is either `null` or the deterministic value
  already computed by `packages/core/src/analysis`.
- **Live** (`AI_MODE=live`) — the official `openai` npm package's
  **Responses API**, with strict JSON-schema structured output generated
  from the same authoritative Zod schema every attempt is validated
  against (`z.toJSONSchema()`, not a hand-duplicated schema) and then
  verified against OpenAI's documented supported subset before use — no
  `prefixItems`/`unevaluatedItems`/`contains`/`minContains`/`maxContains`/
  `propertyNames`/`patternProperties` anywhere, every object schema
  declares `additionalProperties: false` with every property in
  `required` (see `packages/core/src/ai/openai-schema.ts`) — `store:
false`, no streaming/tools/web search/file search/conversations.
  Requires server-only `OPENAI_API_KEY`/`OPENAI_MODEL`. No automated test,
  smoke check, or CI step ever exercises this path — see
  `packages/core/src/ai/openai-provider.ts`.

Every attempt's output — from either provider — is re-validated twice
before anything is persisted: structurally against the authoritative Zod
output schema (which also enforces database-safe bounds — monetary values
fit PostgreSQL `Decimal(12,2)`'s 10-integer-digit capacity, a mitigation
option's proposed schedule impact is bounded to ±3650 days — so a
structurally "valid" response can never fail at the actual write), then
semantically against the request's own model input (every cited source ID
must exist in the supplied evidence allowlist; the reported schedule/budget
exposure must exactly equal the deterministic value already computed). On
a retryable failure (malformed JSON, schema violation, invalid citation,
deterministic mismatch, transient provider error), the orchestration
service retries exactly once with concise validation feedback; a
configuration failure (missing key/model) is never retried. A **persistence**
failure — the provider responded correctly, but writing the result to the
database failed — is a separate, non-retryable category
(`PERSISTENCE_FAILURE`): the provider is never called a second time to
compensate for an application-side write failure. See `docs/SPEC.md` §9–10
and `docs/ARCHITECTURE.md`.

## Limitations

- **Phase 1–5 build.** The deterministic program-logic services
  (traceability, dependency chains, verification gaps, related defects,
  schedule/budget exposure, risk scoring, readiness scoring, bounded
  evidence assembly) exist in `packages/core/src/analysis`, a real
  dashboard/program overview/event-entry form/audit shell call them
  against live Postgres data, a full AI impact-analysis pipeline
  (`packages/core/src/ai`) produces persisted, validated mitigation
  options, and the complete human approval/apply workflow
  (`packages/core/src/approvals`) now takes an approved option through a
  transactional, audited domain mutation. Security hardening beyond what
  each phase has already built (a full threat model, prompt-injection
  defenses, rate limiting) is Phase 6+.
- **`NEW_ACTION` proposed changes have no dedicated domain table.** For
  this MVP, an applied `NEW_ACTION`'s own `ProposedChange` row (its
  `newValue` JSON) is the durable record, surfaced only in the program
  overview's "Actions" section — there is no independent action
  status/assignee lifecycle. See `docs/DECISIONS.md` if this ever needs to
  become a real model.
- **Live AI mode is unverified against the real OpenAI API in this
  repository.** The Responses API request shape and the strict JSON-schema
  structured-output configuration were built against the `openai` npm
  package's published TypeScript types and Structured Outputs
  documentation, but no automated test, smoke check, or CI step is
  permitted to spend real API credit — only `AI_MODE=mock` runs
  automatically anywhere in this repository. A developer with their own
  `OPENAI_API_KEY` should treat a first live run as the actual verification
  of that integration, not this codebase's test suite.
- **Deterministic-equality validation trusts specific Phase 2 field names.**
  Semantic validation (`packages/core/src/ai/output-validation.ts`) compares
  a model's reported schedule/budget exposure against
  `ScheduleExposureResult.directDelayDays` and
  `BudgetExposureResult.totalDeterministicExposure` specifically — see
  `docs/DECISIONS.md`. A future Phase 2 field rename would need this
  mapping updated in lockstep; nothing enforces that automatically today.
- **`next-auth` is on the v5 beta channel** (`5.0.0-beta.31`) — it's the
  version Auth.js's own docs currently recommend for the App Router, but
  it is pre-1.0 and could introduce breaking changes on upgrade.
- **In-memory rate limiting (Phase 6+) will be single-process only** — not
  suitable for a horizontally scaled deployment, and will be documented as
  such when built.
- **Audit append-only-ness is enforced at the application layer only** — no
  update/delete route exists anywhere for `AuditEvent`, but this is not
  cryptographic immutability; see `docs/THREAT_MODEL.md` (Phase 6).
- **The Playwright end-to-end suite is not wired into CI yet** — it's a
  local/manual check (`npm run test:e2e`) for now; Phase 8 owns full CI
  browser-test expansion.
- Three known **moderate npm audit advisories** exist in transitive
  dev-tooling dependencies (an optional nested `@prisma/dev` → old
  `@hono/node-server`, and Next's internally bundled `postcss` copy). Both
  suggested "fixes" would downgrade Prisma or Next to old/breaking
  versions, which is a worse trade than the advisories themselves; tracked
  for revisiting as upstream releases land.
- No production cloud infrastructure, Kubernetes, queues, or public signup
  — intentionally out of scope for this MVP (`docs/SPEC.md` §3).

## Phase roadmap

| Phase | Scope                                                                                         |
| ----- | --------------------------------------------------------------------------------------------- |
| 0     | Plan (architecture, risks, planning docs) — done                                              |
| **1** | **Foundation (workspaces, schema, seed, auth, shell) — done**                                 |
| **2** | **Deterministic program logic (traceability/schedule/budget/risk/readiness/evidence) — done** |
| **3** | **Core workflow UI (dashboard, event entry, audit shell on real data) — done**                |
| **4** | **AI impact analysis (LLMProvider, mock/live, structured output, retry) — done**              |
| **5** | **Approval and audit (state machine, apply preview, transactional apply, audit) — done**      |
| 6     | Security and evals (threat model, prompt-injection defenses, evals)                           |
| 7     | Graph and MCP (React Flow thread view, read-only MCP server)                                  |
| 8     | Delivery (full CI, Docker, browser tests, live eval, polish)                                  |

Full detail: [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Development guidance

Read [`PROJECT_GUIDE.md`](PROJECT_GUIDE.md) and
[`docs/SPEC.md`](docs/SPEC.md) before making changes — they define the
phase-gate process, hard security/testing rules, and fixed architecture
this project follows. Check [`docs/DECISIONS.md`](docs/DECISIONS.md) before
re-deciding something that's already been settled.

If your local editor or development tooling keeps its own config/state
directory in the repo root, exclude it locally via `.git/info/exclude`
rather than adding a tool-specific entry to the tracked `.gitignore`.

## License

No license has been chosen yet. All rights reserved by the author unless
and until a license file is added.
