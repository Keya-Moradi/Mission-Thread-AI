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
