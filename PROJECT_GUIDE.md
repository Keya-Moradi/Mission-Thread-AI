# MissionThread AI — Project Guide

Read this file and `docs/SPEC.md` before planning or editing.

## Hard stop rules

1. Execute only the phase explicitly authorized by the user.
2. The first instruction authorizes Phase 0 only.
3. `continue` authorizes exactly one additional phase.
4. At the end of each phase:
   - run that phase's quality checks;
   - fix failures or document a genuine blocker;
   - update `docs/TASKS.md`;
   - update `docs/DECISIONS.md` when decisions change;
   - summarize files changed, commands run, checks, failures, and risks;
   - STOP.
5. Keep `docs/TASKS.md` detailed enough for a new session to resume without chat history.

## Working rules

- Inspect before editing.
- Prefer small, verifiable changes.
- Never claim a stub or untested feature is complete.
- Never weaken schemas, authorization, tests, or security controls just to pass.
- Check package types or official docs instead of inventing APIs.
- Pin the active Node.js LTS in `.nvmrc`, `package.json` engines, and CI.
- Use npm workspaces and commit `package-lock.json`.
- Do not push, deploy, publish, create cloud resources, or commit unless asked.
- Never expose or log secrets.
- Do not run destructive commands outside the project or its dedicated databases.
- Ask at most one clarification question per phase; otherwise record assumptions in `docs/DECISIONS.md`.
- Add concise contextual comments for non-obvious security boundaries, invariants, architectural tradeoffs, dangerous operations, runtime constraints, and deferred-phase assumptions. Do not comment obvious syntax or merely restate what the code does.

## Fixed architecture

- `apps/web`: Next.js App Router, React, Tailwind, Auth.js, Prisma integration.
- `packages/core`: Zod schemas, deterministic business logic, AI evidence builder, authorization policies, mock fixtures.
- `packages/mcp-server`: later read-only MCP server.
- PostgreSQL + Prisma.
- Auth.js Credentials provider with salted password hashes using Node `crypto.scrypt`.
- `AI_MODE=mock` is deterministic and required for demos and CI.
- `AI_MODE=live` is optional and accessed through an `LLMProvider` interface.
- Seed IDs are fixed and human-readable, such as `REQ-001`, `MS-003`, and `EVT-SUPPLIER-001`.
- All normal calculations are deterministic code, not LLM work.
- AI may explain evidence and propose options; it may never mutate program data.
- Audit events are append-only at the application level; no update/delete paths.
- In-memory rate limiting is acceptable for MVP, with its single-instance limitation documented.
- No pgvector unless a later approved feature creates a real need.
- Protect the workflow spine before polishing React Flow.

## Security rules

- Enforce authorization server-side on every mutation.
- Treat supplier notes and program text as untrusted data, never instructions.
- Validate all external inputs and model outputs with Zod.
- Never render model-generated raw HTML.
- Keep secrets out of client bundles, logs, fixtures, and committed files.
- Use bounded model inputs, action allowlists, and source-ID allowlists.
- Require human approval before proposed changes can be applied.
- Record trace IDs and audit events for analyses, failures, approvals, and changes.
- Never fabricate dates, costs, IDs, or confidence.

## Live-model failure policy

1. Validate the first response.
2. On failure, retry exactly once with concise validation errors.
3. On second failure:
   - do not loosen the schema;
   - persist a failed analysis attempt;
   - create an audit event;
   - show a safe failure state and trace ID;
   - preserve only safe diagnostic metadata.

## Testing rules

- Never use the development database for integration tests.
- Use a dedicated test PostgreSQL database and `.env.test`.
- Test reset scripts must refuse to run unless the database name clearly contains a test marker.
- CI always uses `AI_MODE=mock`.
- Mock evals prove pipeline and policy behavior, not general model quality.
- Before portfolio completion, run live evals once and summarize them in `docs/EVAL_RESULTS.md`.
