# Architecture

## Workspaces

- `apps/web` — Next.js App Router UI + route handlers/server actions.
- `packages/core` — Zod schemas, deterministic services, Prisma schema/client, AI evidence builder + `LLMProvider`, mock fixtures, authorization policy helpers.
- `packages/mcp-server` — Phase 7: read-only MCP tools reusing `packages/core`.

## Request / data flow

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

## Domain model

See `docs/DECISIONS.md` (2026-07-17 entries) for the approved 20-model Prisma set and the three merges applied to the `SPEC.md` §6 baseline (`TestResult`→`TestCase`, `SupplierUpdate`→`ProgramEvent`, `Approval`→`Decision`). Full schema is authored in Phase 1 at `packages/core/prisma/schema.prisma`.

## Auth

Auth.js Credentials provider; `crypto.scrypt` password hashes; server-side session and role check on every mutation. UI role-gating is cosmetic only, never authoritative. Roles: Program Manager (full workflow), Engineering Lead (review + request revision), Executive Viewer (read-only).

## Persistence

PostgreSQL via Prisma, single schema in `packages/core/prisma`. Dev and test databases are separate logical databases in the same local Docker Compose Postgres instance (host port `55432`, chosen to avoid colliding with a local Postgres already on 5432), selected via `DATABASE_URL` vs `TEST_DATABASE_URL`. The test reset script refuses to run unless the target database name contains a test marker.

## AI

`LLMProvider` interface with a mock implementation (deterministic, no API key, used in CI/demo) and an optional live implementation (single provider adapter, server-only secret). Prompts live under `packages/core/src/ai/prompts`. The model receives only validated, bounded evidence — never raw database dumps — and untrusted text (e.g. supplier notes) is passed as clearly isolated data, never as instructions.

## Observability

Structured JSON logs; a trace ID is generated per analysis attempt (timestamp, user ID, program/event IDs, AI mode, provider/model, duration, attempt number, success/failure, safe error category). Secrets, credentials, tokens, full prompts, and full untrusted notes are never logged. Trace IDs are surfaced in the UI on analyses, failures, briefings, and audit entries.

## Deployment (MVP)

Local Docker Compose only (Postgres service). No cloud infrastructure, no Kubernetes, no queues, no pgvector.
