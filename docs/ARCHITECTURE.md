# Architecture

This document describes the **target** architecture established during
Phase 0 planning. Sections are marked with what phase actually builds them;
see [`docs/TASKS.md`](TASKS.md) for what exists in the repository right now.
As of this writing, Phase 1 (workspaces, schema, seed data, auth, base
shell) is complete; everything under "Request / data flow", "AI", and most
of "Observability" below is still planned, not implemented.

## Workspaces

- `apps/web` — Next.js App Router UI + route handlers/server actions. _(Phase 1: scaffold, auth, base shell. Phases 3–5: dashboard, event entry, analysis workspace, approval UI.)_
- `packages/core` — Zod schemas, deterministic services, Prisma schema/client. _(Phase 1: schema, auth, seed, db-safety. Phase 2: deterministic services. Phase 4: AI evidence builder + `LLMProvider`, mock fixtures, prompts.)_
- `packages/mcp-server` — Phase 7: read-only MCP tools reusing `packages/core`. _(Not started — placeholder package only.)_

## Request / data flow — planned (Phases 2–5), not yet implemented

```
Program Manager submits supplier delay
  -> apps/web: POST /programs/edgelink-x/events (Zod-validated, server-side auth check)
  -> packages/core: buildAnalysisEvidence(eventId)
       - getImpactedRequirements / getImpactedMilestones / getDependencyChain
       - getVerificationGaps / getRelatedDefects
       - calculateScheduleExposure / calculateBudgetExposure
       - assembles bounded, allowlisted evidence (record id + type + safe summary)
  -> LLMProvider (mock in dev/CI, live optional) -> strict Zod-validated structured output
       (exec summary, exposures, 3 mitigation options, assumptions, unknowns, confidence, source IDs)
       on failure: 1 retry -> persist FAILED analysis + AuditEvent, schema never loosened
  -> Analysis workspace UI -> Program Manager approves / rejects / requests revision
  -> Decision + AuditEvent recorded -> apply-preview screen (old/new values) -> explicit confirm
  -> DB transaction applies ProposedChanges (milestones/risks/budget/new actions) + AuditEvent
```

None of this flow is wired up yet. Today, `apps/web` only reads a handful of
counts from Postgres for the dashboard shell — there is no event intake, no
evidence builder, no AI call, and no approval or apply path.

## Domain model — implemented (Phase 1)

See `docs/DECISIONS.md` for the approved 20-model Prisma set, the three
merges applied to the `SPEC.md` §6 baseline (`TestResult`→`TestCase`,
`SupplierUpdate`→`ProgramEvent`, `Approval`→`Decision`), and the
`RecordType` allowlist design. Schema lives at
`packages/core/prisma/schema.prisma` and is migrated/seeded.

## Auth — implemented (Phase 1)

Auth.js Credentials provider; `crypto.scrypt` password hashes (validated
strictly on verify — see `docs/DECISIONS.md`); JWT sessions; server-side
session check via `auth()` in server layouts and pages. UI role-gating is
cosmetic only, never authoritative. Roles: Program Manager (full workflow —
not yet built), Engineering Lead (review + request revision — not yet
built), Executive Viewer (read-only). Role-based **authorization on
mutations** is planned for Phase 3+, once mutations exist.

## Persistence — implemented (Phase 1)

PostgreSQL via Prisma, single schema in `packages/core/prisma`. Dev and
test databases are separate logical databases in the same local Docker
Compose Postgres instance (host port `55432`, chosen to avoid colliding
with a local Postgres already on 5432), selected via `DATABASE_URL` vs
`TEST_DATABASE_URL`. Every destructive operation (test reset, dev reseed)
passes through the shared guard in `packages/core/src/db-safety.ts`.

## AI — planned (Phase 4), not yet implemented

`LLMProvider` interface with a mock implementation (deterministic, no API
key, used in CI/demo) and an optional live implementation (single provider
adapter, server-only secret). Prompts will live under
`packages/core/src/ai/prompts`. The model will receive only validated,
bounded evidence — never raw database dumps — and untrusted text (e.g.
supplier notes) will be passed as clearly isolated data, never as
instructions. None of this exists in the codebase yet.

## Observability — partially implemented

Structured JSON logging, per-analysis trace IDs, and UI trace-ID surfacing
are planned for Phase 4+, once there are analysis attempts to log. Today,
the only "observability" is Next's own dev/build console output and the
safe (credential-free) messages returned by the destructive-operation
guard.

## Deployment (MVP)

Local Docker Compose only (Postgres service). No cloud infrastructure, no
Kubernetes, no queues, no pgvector. See `README.md` for the current state
of the application Dockerfile.
