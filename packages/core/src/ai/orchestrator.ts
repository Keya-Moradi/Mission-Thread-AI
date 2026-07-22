import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { entityIdSchema } from "../analysis/schemas";
import { buildAnalysisEvidence } from "../analysis/evidence";
import { ok, notFound, validationError, forbidden, type ServiceResult } from "../analysis/types";
import { createProviderFromEnv } from "./provider-factory";
import {
  buildModelInputProjection,
  checkModelInputSize,
  modelInputProjectionSchema,
  type ModelInputProjection,
} from "./model-input";
import { IMPACT_ANALYSIS_SYSTEM_PROMPT } from "./prompts/impact-analysis-system";
import {
  impactAnalysisOutputSchema,
  summarizeOutputSchemaErrors,
  type ImpactAnalysisOutput,
} from "./output-schema";
import { validateImpactAnalysisSemantics } from "./output-validation";
import { classifyProviderError, isRetryableCategory, type AiErrorCategory } from "./errors";
import { logAnalysisEvent } from "./logging";
import {
  buildAttemptSourceReferenceSnapshot,
  buildSucceededImpactAnalysisData,
} from "./attempt-persistence";
import type { LLMProvider, LLMProviderRequest } from "./provider";

const MAX_ATTEMPTS = 2;

export interface RunImpactAnalysisResult {
  analysisRunId: string;
  status: "SUCCEEDED" | "FAILED";
  finalAnalysisId: string;
  finalTraceId: string;
  attempts: number;
  errorCategory?: AiErrorCategory;
}

// ---------------------------------------------------------------------------
// Persistence — isolated behind a narrow interface (AnalysisPersistence)
// specifically so tests can make one stage fail in isolation without a
// brittle global Prisma mock. The production default (defaultAnalysisPersistence)
// is the only implementation ever wired into the web app; runImpactAnalysis()'s
// options.persistence override exists purely for tests — apps/web never
// passes it. See docs/DECISIONS.md, "Persistence-boundary repair: directly
// testable persistence injection".
// ---------------------------------------------------------------------------

export interface PersistPendingAttemptParams {
  analysisId: string;
  programEventId: string;
  analysisRunId: string;
  requestedById: string;
  traceId: string;
  attempt: number;
  aiMode: string;
  providerName: string;
  modelInput: ModelInputProjection;
}

export interface PersistSucceededAttemptParams {
  analysisId: string;
  traceId: string;
  actorUserId: string;
  eventId: string;
  durationMs: number;
  providerModel?: string;
  output: ImpactAnalysisOutput;
  modelInput: ModelInputProjection;
}

export interface PersistFailedAttemptParams {
  analysisId: string;
  category: AiErrorCategory;
  durationMs: number;
  validationErrors: string[] | null;
  providerModel?: string;
}

export interface AnalysisPersistence {
  persistPendingAttempt(params: PersistPendingAttemptParams): Promise<void>;
  persistSucceededAttempt(params: PersistSucceededAttemptParams): Promise<void>;
  persistFailedAttempt(params: PersistFailedAttemptParams): Promise<void>;
}

/**
 * Persists the complete evidence snapshot an attempt was built from —
 * every allowlisted record, wasCited:false — plus the PENDING
 * ImpactAnalysis row and its ANALYSIS_STARTED audit event, all in one
 * transaction, before the provider is ever called. See
 * docs/DECISIONS.md, "Phase 4 correction: complete attempt-evidence
 * persistence" — a failed attempt's rows are never touched again after
 * this, so they correctly retain the full supplied snapshot. If this
 * transaction throws, Prisma rolls back all three writes atomically — no
 * partial attempt is ever left behind for the caller to mistake as real.
 */
async function persistPendingAttempt(params: PersistPendingAttemptParams): Promise<void> {
  const {
    analysisId,
    programEventId,
    analysisRunId,
    requestedById,
    traceId,
    attempt,
    aiMode,
    providerName,
    modelInput,
  } = params;

  const suppliedSnapshot = buildAttemptSourceReferenceSnapshot(modelInput);

  await prisma.$transaction(async (tx) => {
    await tx.impactAnalysis.create({
      data: {
        id: analysisId,
        programEventId,
        analysisRunId,
        requestedById,
        traceId,
        attempt,
        status: "PENDING",
        aiMode,
        provider: providerName,
      },
    });

    for (const item of suppliedSnapshot) {
      await tx.sourceReference.create({
        data: {
          impactAnalysisId: analysisId,
          recordId: item.recordId,
          recordType: item.recordType,
          summary: item.summary,
          wasCited: item.wasCited,
          citationContexts: item.citationContexts,
        },
      });
    }

    await tx.auditEvent.create({
      data: {
        traceId,
        actorUserId: requestedById,
        actorType: "USER",
        action: "ANALYSIS_STARTED",
        targetRecordId: analysisId,
        targetRecordType: "IMPACT_ANALYSIS",
        afterValue: { eventId: programEventId, analysisRunId, attempt },
      },
    });
  });
}

async function persistFailedAttempt(params: PersistFailedAttemptParams): Promise<void> {
  const { analysisId, category, durationMs, validationErrors, providerModel } = params;
  await prisma.impactAnalysis.update({
    where: { id: analysisId },
    data: {
      status: "FAILED",
      validationPassed: false,
      validationErrors: validationErrors ?? undefined,
      errorCategory: category,
      durationMs,
      model: providerModel,
    },
  });
}

/**
 * Final transaction for a successful attempt: updates the already-created
 * ImpactAnalysis row (deterministic values from modelInput, never the
 * model's own copy — see buildSucceededImpactAnalysisData()), updates the
 * cited subset of the already-persisted SourceReference rows with citation
 * metadata (never re-creates them — they exist from persistPendingAttempt),
 * creates exactly 3 MitigationOption rows, and the ANALYSIS_SUCCEEDED audit
 * event. If this transaction throws partway through, Prisma rolls it back
 * entirely — zero MitigationOption rows ever survive a failed success
 * transaction, and the SourceReference rows persisted by
 * persistPendingAttempt are untouched (they live in an already-committed,
 * earlier transaction).
 */
async function persistSucceededAttempt(params: PersistSucceededAttemptParams): Promise<void> {
  const {
    analysisId,
    traceId,
    actorUserId,
    eventId,
    durationMs,
    providerModel,
    output,
    modelInput,
  } = params;

  const data = buildSucceededImpactAnalysisData(output, modelInput);
  const citedSnapshot = buildAttemptSourceReferenceSnapshot(modelInput, output);

  await prisma.$transaction(async (tx) => {
    await tx.impactAnalysis.update({
      where: { id: analysisId },
      data: {
        status: data.status,
        validationPassed: data.validationPassed,
        validationErrors: undefined,
        executiveSummary: data.executiveSummary,
        missionImpact: data.missionImpact,
        scheduleExposureDays: data.scheduleExposureDays,
        budgetExposureAmount: data.budgetExposureAmount,
        // DbNull, not JsonNull: an unavailable readiness snapshot must be a
        // real SQL NULL in this nullable Json column, not the stored JSON
        // literal "null" — see docs/DECISIONS.md, "Phase 4 correction:
        // immutable readiness snapshot".
        readinessSnapshot: data.readinessSnapshot ?? Prisma.DbNull,
        verificationGaps: data.verificationGaps,
        assumptions: data.assumptions,
        unknowns: data.unknowns,
        confidence: data.confidence,
        durationMs,
        model: providerModel,
      },
    });

    for (const item of citedSnapshot) {
      // Uncited rows are already correctly wasCited:false from
      // persistPendingAttempt's initial transaction — only the cited subset
      // needs an update here.
      if (!item.wasCited) continue;
      await tx.sourceReference.update({
        where: {
          impactAnalysisId_recordType_recordId: {
            impactAnalysisId: analysisId,
            recordType: item.recordType,
            recordId: item.recordId,
          },
        },
        data: { wasCited: true, citationContexts: item.citationContexts },
      });
    }

    for (const [index, option] of output.mitigationOptions.entries()) {
      await tx.mitigationOption.create({
        data: {
          impactAnalysisId: analysisId,
          optionIndex: index,
          title: option.title,
          description: option.description,
          tradeoffs: option.tradeoffs,
          costImpact: option.costImpact,
          scheduleImpact: option.scheduleImpact,
          isRecommended: option.isRecommended,
        },
      });
    }

    await tx.auditEvent.create({
      data: {
        traceId,
        actorUserId,
        actorType: "USER",
        action: "ANALYSIS_SUCCEEDED",
        targetRecordId: analysisId,
        targetRecordType: "IMPACT_ANALYSIS",
        afterValue: { eventId, confidence: output.confidence },
      },
    });
  });
}

/** The only persistence implementation ever wired into the web app. */
export const defaultAnalysisPersistence: AnalysisPersistence = {
  persistPendingAttempt,
  persistSucceededAttempt,
  persistFailedAttempt,
};

// ---------------------------------------------------------------------------
// Provider stage — invocation, response parsing, structural validation, and
// semantic validation, isolated from persistence. The try/catch here covers
// ONLY the provider call itself (and any provider-originated parsing error
// thrown from inside it, e.g. AiProviderError("...", "MALFORMED_JSON") from
// openai-provider.ts) — structural/semantic validation never throw (they use
// safeParse and return a result object), so nothing downstream of the
// provider call can be miscategorized as a provider failure. See
// docs/DECISIONS.md, "Persistence-boundary repair: provider vs. persistence
// failure separation".
// ---------------------------------------------------------------------------

type AttemptOutcome =
  | { kind: "provider-failure"; category: AiErrorCategory; durationMs: number }
  | {
      kind: "validation-failure";
      category: "INVALID_OUTPUT_SCHEMA" | "SEMANTIC_VALIDATION_FAILED";
      errors: string[];
      durationMs: number;
      providerModel?: string;
    }
  | { kind: "success"; output: ImpactAnalysisOutput; durationMs: number; providerModel?: string };

async function runProviderAndValidate(
  provider: LLMProvider,
  request: LLMProviderRequest,
  modelInput: ModelInputProjection,
): Promise<AttemptOutcome> {
  const startedAt = Date.now();

  // STAGE: provider invocation (the only stage this try/catch covers).
  let rawOutput: unknown;
  let providerModel: string | undefined;
  let durationMs: number;
  try {
    const response = await provider.generateImpactAnalysis(request);
    rawOutput = response.rawOutput;
    providerModel = response.model;
    durationMs = response.durationMs;
  } catch (error) {
    return {
      kind: "provider-failure",
      category: classifyProviderError(error),
      durationMs: Date.now() - startedAt,
    };
  }

  // STAGE: structural validation — outside the provider try/catch; safeParse
  // never throws.
  const structural = impactAnalysisOutputSchema.safeParse(rawOutput);
  if (!structural.success) {
    return {
      kind: "validation-failure",
      category: "INVALID_OUTPUT_SCHEMA",
      errors: summarizeOutputSchemaErrors(structural.error),
      durationMs,
      providerModel,
    };
  }

  // STAGE: semantic validation — also outside the provider try/catch.
  const semantic = validateImpactAnalysisSemantics(structural.data, modelInput);
  if (!semantic.valid) {
    return {
      kind: "validation-failure",
      category: "SEMANTIC_VALIDATION_FAILED",
      errors: semantic.errors,
      durationMs,
      providerModel,
    };
  }

  return { kind: "success", output: structural.data, durationMs, providerModel };
}

// ---------------------------------------------------------------------------
// Safe infrastructure-failure responses — used whenever persistence itself
// (not the provider, not validation) is what failed. Never reads or forwards
// the triggering error's message: the caught error is always discarded
// entirely, never logged, persisted, or included in a returned message —
// only these fixed, safe strings are ever surfaced.
// ---------------------------------------------------------------------------

function safeInfrastructureFailure(): ServiceResult<RunImpactAnalysisResult> {
  return validationError(
    "An internal error prevented processing this analysis attempt. Please try again.",
  );
}

/**
 * The provider already returned a structurally and semantically valid
 * output, but persistSucceededAttempt() failed (persistSucceededAttempt's
 * own transaction has already rolled back — zero MitigationOption rows, no
 * partial success state). Never calls the provider again and never emits
 * analysis.retrying: a persistence failure has nothing to do with whether
 * the provider's response was good, and retrying would waste a second,
 * identical provider call for a response that was already correct. Attempts
 * to record FAILED/PERSISTENCE_FAILURE through the same persistence
 * interface — a separate call from the one that just failed, on the theory
 * that a transient write failure need not repeat on the very next write —
 * and only creates the ANALYSIS_FAILED audit event if that succeeds. If
 * even that fails, persistence is clearly unavailable, so this returns a
 * generic infrastructure failure rather than fabricating a "provider
 * failed" story or a false claim that FAILED was recorded.
 */
async function recordPersistenceFailureAfterValidOutput(params: {
  persistence: AnalysisPersistence;
  analysisId: string;
  traceId: string;
  actorUserId: string;
  eventId: string;
  analysisRunId: string;
  attempt: number;
  durationMs: number;
  providerModel?: string;
  aiMode: string;
  providerName: string;
}): Promise<ServiceResult<RunImpactAnalysisResult>> {
  const {
    persistence,
    analysisId,
    traceId,
    actorUserId,
    eventId,
    analysisRunId,
    attempt,
    durationMs,
    providerModel,
    aiMode,
    providerName,
  } = params;
  const category: AiErrorCategory = "PERSISTENCE_FAILURE";

  try {
    await persistence.persistFailedAttempt({
      analysisId,
      category,
      durationMs,
      validationErrors: null,
      providerModel,
    });
  } catch {
    return safeInfrastructureFailure();
  }

  try {
    await prisma.auditEvent.create({
      data: {
        traceId,
        actorUserId,
        actorType: "USER",
        action: "ANALYSIS_FAILED",
        targetRecordId: analysisId,
        targetRecordType: "IMPACT_ANALYSIS",
        afterValue: { eventId, analysisRunId, attempt, errorCategory: category },
      },
    });
  } catch {
    // Best-effort — the FAILED status itself was already durably recorded
    // above; an audit-write hiccup on top of that doesn't change the
    // outcome being reported.
  }

  logAnalysisEvent("analysis.failed", {
    traceId,
    analysisRunId,
    analysisId,
    attempt,
    eventId,
    requestedById: actorUserId,
    aiMode,
    provider: providerName,
    status: "FAILED",
    validationPassed: false,
    errorCategory: category,
  });

  return ok({
    analysisRunId,
    status: "FAILED",
    finalAnalysisId: analysisId,
    finalTraceId: traceId,
    attempts: attempt,
    errorCategory: category,
  });
}

/**
 * The Phase 4 orchestration service: authorizes the actor, builds bounded
 * deterministic evidence and a validated model-input projection, then runs
 * the provider attempt lifecycle (persist PENDING row + full evidence
 * snapshot + audit start in one transaction -> call provider outside any
 * transaction -> structural then semantic validation -> persist). Retries
 * at most once, only on a retryable failure category — see errors.ts.
 * Creates zero Decision/ProposedChange rows; this is Phase 4 only (analysis
 * + mitigation options), never Phase 5's approval/apply workflow. See
 * docs/DECISIONS.md, "Phase 4 orchestration".
 *
 * `options.persistence` is a test-only override point (see
 * AnalysisPersistence above) — apps/web never supplies it.
 */
export async function runImpactAnalysis(
  eventId: string,
  actorUserId: string,
  options?: { provider?: LLMProvider; persistence?: Partial<AnalysisPersistence> },
): Promise<ServiceResult<RunImpactAnalysisResult>> {
  if (!actorUserId || typeof actorUserId !== "string") {
    return forbidden("Invalid session.");
  }

  // Re-fetched fresh from the database on every call — never a JWT/session
  // role claim. Mirrors recordProgramEvent()'s own authorization pattern
  // (packages/core/src/events/record-program-event.ts).
  const actor = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { id: true, role: true },
  });
  if (!actor) {
    return forbidden("Your session is no longer valid. Please sign in again.");
  }
  if (actor.role !== "PROGRAM_MANAGER") {
    return forbidden("Only a Program Manager may run an impact analysis.");
  }

  const parsedEventId = entityIdSchema.safeParse(eventId);
  if (!parsedEventId.success) {
    return validationError(parsedEventId.error.issues.map((issue) => issue.message).join("; "));
  }

  const event = await prisma.programEvent.findUnique({
    where: { id: parsedEventId.data },
    select: { id: true },
  });
  if (!event) {
    return notFound("PROGRAM_EVENT", parsedEventId.data);
  }

  const evidenceResult = await buildAnalysisEvidence(event.id);
  if (!evidenceResult.ok) {
    return evidenceResult;
  }

  let modelInput: ModelInputProjection;
  try {
    modelInput = buildModelInputProjection(evidenceResult.data);
  } catch {
    return validationError("Failed to build a valid model-input projection for this event.");
  }

  // Runtime validation of the just-built projection against its own
  // authoritative schema — before the size check and before any attempt
  // (analysis row, audit event, or provider call) is created. A failure
  // here is a programming-invariant violation (buildModelInputProjection()
  // is supposed to always produce a schema-valid result), not a normal
  // operating condition, but it's checked rather than assumed — see
  // docs/DECISIONS.md, "Phase 4 correction: runtime model-input
  // validation".
  const modelInputValidation = modelInputProjectionSchema.safeParse(modelInput);
  if (!modelInputValidation.success) {
    return validationError(
      `Model input failed runtime validation: ${modelInputValidation.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`,
    );
  }

  const sizeCheck = checkModelInputSize(modelInput);
  if (!sizeCheck.ok) {
    return validationError(
      `Model input exceeds the maximum allowed size (${sizeCheck.sizeBytes} of ${sizeCheck.maxBytes} bytes).`,
    );
  }

  let provider: LLMProvider;
  try {
    provider = options?.provider ?? createProviderFromEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI provider configuration failed.";
    return validationError(message);
  }
  const aiMode = process.env.AI_MODE ?? "unknown";

  // Test-only override point — production always uses defaultAnalysisPersistence.
  const persistence: AnalysisPersistence = {
    ...defaultAnalysisPersistence,
    ...options?.persistence,
  };

  const analysisRunId = `RUN-${randomUUID()}`;
  let validationFeedback: string[] | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const traceId = randomUUID();
    const analysisId = `IA-${randomUUID()}`;

    // STAGE: pending-attempt persistence. Never provider-related — a
    // failure here must never be classified via classifyProviderError(),
    // must never trigger a provider call, and must never look like a
    // completed attempt (persistPendingAttempt's transaction guarantees
    // that on failure, none of its three writes survive).
    try {
      await persistence.persistPendingAttempt({
        analysisId,
        programEventId: event.id,
        analysisRunId,
        requestedById: actor.id,
        traceId,
        attempt,
        aiMode,
        providerName: provider.name,
        modelInput,
      });
    } catch {
      return safeInfrastructureFailure();
    }

    logAnalysisEvent("analysis.started", {
      traceId,
      analysisRunId,
      analysisId,
      attempt,
      eventId: event.id,
      requestedById: actor.id,
      aiMode,
      provider: provider.name,
    });

    const outcome = await runProviderAndValidate(
      provider,
      {
        traceId,
        analysisRunId,
        attempt,
        systemPrompt: IMPACT_ANALYSIS_SYSTEM_PROMPT,
        modelInput,
        validationFeedback,
      },
      modelInput,
    );

    if (outcome.kind === "success") {
      // STAGE: success persistence — its own try/catch, entirely separate
      // from the provider stage above. A failure here is never retried and
      // never re-invokes the provider.
      try {
        await persistence.persistSucceededAttempt({
          analysisId,
          traceId,
          actorUserId: actor.id,
          eventId: event.id,
          durationMs: outcome.durationMs,
          providerModel: outcome.providerModel,
          output: outcome.output,
          modelInput,
        });
      } catch {
        return recordPersistenceFailureAfterValidOutput({
          persistence,
          analysisId,
          traceId,
          actorUserId: actor.id,
          eventId: event.id,
          analysisRunId,
          attempt,
          durationMs: outcome.durationMs,
          providerModel: outcome.providerModel,
          aiMode,
          providerName: provider.name,
        });
      }

      logAnalysisEvent("analysis.succeeded", {
        traceId,
        analysisRunId,
        analysisId,
        attempt,
        eventId: event.id,
        requestedById: actor.id,
        aiMode,
        provider: provider.name,
        model: outcome.providerModel,
        durationMs: outcome.durationMs,
        status: "SUCCEEDED",
        validationPassed: true,
      });
      return ok({
        analysisRunId,
        status: "SUCCEEDED",
        finalAnalysisId: analysisId,
        finalTraceId: traceId,
        attempts: attempt,
      });
    }

    // outcome.kind is "provider-failure" | "validation-failure" here.
    const category = outcome.category;
    const safeErrors = outcome.kind === "validation-failure" ? outcome.errors : null;
    const providerModel = outcome.kind === "validation-failure" ? outcome.providerModel : undefined;
    const durationMs = outcome.durationMs;

    try {
      await persistence.persistFailedAttempt({
        analysisId,
        category,
        durationMs,
        validationErrors: safeErrors,
        providerModel,
      });
    } catch {
      return safeInfrastructureFailure();
    }

    try {
      await prisma.auditEvent.create({
        data: {
          traceId,
          actorUserId: actor.id,
          actorType: "USER",
          action: "ANALYSIS_FAILED",
          targetRecordId: analysisId,
          targetRecordType: "IMPACT_ANALYSIS",
          afterValue: { eventId: event.id, analysisRunId, attempt, errorCategory: category },
        },
      });
    } catch {
      // Best-effort — the FAILED status itself was already durably
      // recorded above.
    }

    logAnalysisEvent("analysis.failed", {
      traceId,
      analysisRunId,
      analysisId,
      attempt,
      eventId: event.id,
      requestedById: actor.id,
      aiMode,
      provider: provider.name,
      status: "FAILED",
      validationPassed: false,
      errorCategory: category,
    });

    const canRetry = attempt < MAX_ATTEMPTS && isRetryableCategory(category);
    if (!canRetry) {
      return ok({
        analysisRunId,
        status: "FAILED",
        finalAnalysisId: analysisId,
        finalTraceId: traceId,
        attempts: attempt,
        errorCategory: category,
      });
    }

    logAnalysisEvent("analysis.retrying", {
      traceId,
      analysisRunId,
      analysisId,
      attempt,
      eventId: event.id,
      requestedById: actor.id,
      aiMode,
      provider: provider.name,
      errorCategory: category,
    });
    validationFeedback = safeErrors ?? undefined;
  }

  // Unreachable given MAX_ATTEMPTS >= 1 and the loop's own return paths, but
  // keeps the function's return type total rather than relying on the loop
  // shape alone.
  return validationError("Impact analysis failed for an unknown reason.");
}
