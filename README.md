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

**Phase 1 of 8 (Foundation) — complete.** Workspaces, database schema,
deterministic seed data, authentication, and a minimal application shell
exist and are verified working end-to-end. The actual supplier-delay →
analysis → approval → audit workflow has not been built yet; see
[Phase roadmap](#phase-roadmap) and [Limitations](#limitations) below.

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
approve anything, or apply a change.

## Architecture

npm workspaces monorepo:

```
apps/web              Next.js App Router UI, route handlers, server actions
packages/core          Zod schemas, deterministic services, Prisma schema/client,
                        AI evidence builder, mock fixtures (Phase 2+)
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
- Vitest (unit tests); Playwright (Phase 5+)
- Docker Compose (local Postgres); GitHub Actions (CI)
- Structured JSON logging (Phase 4+)

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
before recreating the deterministic fixtures, so it requires the
deliberately named command below rather than a plain `db:seed`:

```bash
npm run db:seed:destructive  # clears and reseeds missionthread_dev
```

This works via a shared guard (`packages/core/src/db-safety.ts`) that only
authorizes an exact, approved `(host, port, database)` target — never a
name that merely _looks_ right — and only for the one child process this
command spawns; see `.env.example` for why the authorization flag itself
is never checked into any example file.

### Test database

Integration tests must never run against the dev database. The reset
script only authorizes an exact approved local test target
(`localhost:55432/missionthread_test` or `127.0.0.1:55432/missionthread_test`)
— not merely a database name containing "test":

```bash
npm run db:reset:test  # drops, re-migrates, and reseeds missionthread_test only
```

## Running the app

```bash
npm run dev
```

Visit `http://localhost:3000` — you'll be redirected to `/login`.

### Demo accounts

Seeded by `npm run db:seed:destructive`, one per role. The password below is a fixed,
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
```

`smoke:test` builds the production app, then runs
`apps/web/scripts/smoke-test.mjs` against it, always pointed at the
dedicated test database (loaded from `.env.test`, never the dev database —
see the script's own comment for why). It exercises the full auth flow:
unauthenticated redirects to `/login`, invalid credentials failing safely,
valid seeded credentials authenticating, session contents (user ID and
role), the authenticated dashboard rendering real seeded data, protected
nav routes, and sign-out actually invalidating the session — 21 checks,
run against the dedicated test database, never the dev database.

All of the above are run in CI (`.github/workflows/ci.yml`) with
`AI_MODE=mock`, so the pipeline never needs a live model API key.

## Current routes and functionality (Phase 1)

- `/login` — Credentials sign-in (Zod-validated, scrypt + `timingSafeEqual`
  password verification, JWT session).
- `/` — Executive dashboard shell: real counts (requirements, milestones,
  open risks, recorded events) pulled live from Postgres via Prisma.
- `/programs/edgelink-x`, `/audit` — authenticated placeholder pages
  confirming navigation, layout, and auth gating; full functionality is
  Phase 3 and Phase 5 respectively.

Nothing beyond authentication and read-only counts is wired up yet — there
is no event entry, no AI analysis, no approval workflow, and no audit log
in this phase.

## Security and authorization

- Passwords are hashed with Node's `crypto.scrypt` (OWASP-recommended
  parameters) and verified with `crypto.timingSafeEqual`; see
  `packages/core/src/auth/password.ts`.
- Sessions use Auth.js v5 with the **JWT** strategy explicitly (no database
  session/Account/VerificationToken models — unnecessary for a
  Credentials-only setup).
- All input to the Credentials provider is validated with Zod before it
  touches the database.
- Authorization is intended to be enforced server-side on every mutation
  once mutations exist (Phase 3+); UI role-gating is never treated as
  sufficient on its own. No Next.js middleware/proxy is used for auth in
  this phase — `auth()` is called directly in server layouts and pages,
  which keeps Prisma and `node:crypto` out of the Edge runtime entirely.

## Mock vs. live AI

Not built yet (Phase 4). The eventual design: an `LLMProvider` interface
with a deterministic **mock** mode (no API key, used in CI and demos) and
an optional **live** mode (one provider adapter, server-only secret,
validated output with exactly one retry on failure). See `docs/SPEC.md` §9–10.

## Limitations

- **Single Phase 1 build.** No deterministic business logic, AI pipeline,
  approval workflow, or audit trail exists yet.
- **`next-auth` is on the v5 beta channel** (`5.0.0-beta.31`) — it's the
  version Auth.js's own docs currently recommend for the App Router, but
  it is pre-1.0 and could introduce breaking changes on upgrade.
- **In-memory rate limiting (Phase 6+) will be single-process only** — not
  suitable for a horizontally scaled deployment, and will be documented as
  such when built.
- **Audit append-only-ness (Phase 5+) is enforced at the application layer
  only** — no update/delete route will exist, but this is not cryptographic
  immutability.
- Three known **moderate npm audit advisories** exist in transitive
  dev-tooling dependencies (an optional nested `@prisma/dev` → old
  `@hono/node-server`, and Next's internally bundled `postcss` copy). Both
  suggested "fixes" would downgrade Prisma or Next to old/breaking
  versions, which is a worse trade than the advisories themselves; tracked
  for revisiting as upstream releases land.
- No production cloud infrastructure, Kubernetes, queues, or public signup
  — intentionally out of scope for this MVP (`docs/SPEC.md` §3).

## Phase roadmap

| Phase | Scope                                                                 |
| ----- | --------------------------------------------------------------------- |
| 0     | Plan (architecture, risks, planning docs) — done                      |
| **1** | **Foundation (workspaces, schema, seed, auth, shell) — done**         |
| 2     | Deterministic program logic (schedule/budget/risk/readiness services) |
| 3     | Core workflow UI (dashboard, event entry, audit shell on real data)   |
| 4     | AI impact analysis (LLMProvider, mock/live, structured output, retry) |
| 5     | Approval and audit (state machine, apply preview, append-only audit)  |
| 6     | Security and evals (threat model, prompt-injection defenses, evals)   |
| 7     | Graph and MCP (React Flow thread view, read-only MCP server)          |
| 8     | Delivery (full CI, Docker, browser tests, live eval, polish)          |

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
