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
import { impactAnalysisOutputSchema, summarizeOutputSchemaErrors } from "./output-schema";
import { validateImpactAnalysisSemantics } from "./output-validation";
import { classifyProviderError, isRetryableCategory, type AiErrorCategory } from "./errors";
import { logAnalysisEvent } from "./logging";
import {
  buildAttemptSourceReferenceSnapshot,
  buildSucceededImpactAnalysisData,
} from "./attempt-persistence";
import type { LLMProvider } from "./provider";

const MAX_ATTEMPTS = 2;

export interface RunImpactAnalysisResult {
  analysisRunId: string;
  status: "SUCCEEDED" | "FAILED";
  finalAnalysisId: string;
  finalTraceId: string;
  attempts: number;
  errorCategory?: AiErrorCategory;
}

/**
 * Persists the complete evidence snapshot an attempt was built from —
 * every allowlisted record, wasCited:false — plus the PENDING
 * ImpactAnalysis row and its ANALYSIS_STARTED audit event, all in one
 * transaction, before the provider is ever called. See
 * docs/DECISIONS.md, "Phase 4 correction: complete attempt-evidence
 * persistence" — a failed attempt's rows are never touched again after
 * this, so they correctly retain the full supplied snapshot.
 */
async function persistPendingAttempt(params: {
  analysisId: string;
  programEventId: string;
  analysisRunId: string;
  requestedById: string;
  traceId: string;
  attempt: number;
  aiMode: string;
  providerName: string;
  modelInput: ModelInputProjection;
}): Promise<void> {
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

async function persistFailedAttempt(params: {
  analysisId: string;
  category: AiErrorCategory;
  durationMs: number;
  validationErrors: string[] | null;
  providerModel?: string;
}): Promise<void> {
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
 * event.
 */
async function persistSucceededAttempt(params: {
  analysisId: string;
  traceId: string;
  actorUserId: string;
  eventId: string;
  durationMs: number;
  providerModel?: string;
  output: import("./output-schema").ImpactAnalysisOutput;
  modelInput: ModelInputProjection;
}): Promise<void> {
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
 */
export async function runImpactAnalysis(
  eventId: string,
  actorUserId: string,
  options?: { provider?: LLMProvider },
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

  const analysisRunId = `RUN-${randomUUID()}`;
  let validationFeedback: string[] | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const traceId = randomUUID();
    const analysisId = `IA-${randomUUID()}`;

    await persistPendingAttempt({
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

    const startedAt = Date.now();
    let category: AiErrorCategory = "TRANSIENT_PROVIDER_FAILURE";
    let safeErrors: string[] | null = null;
    let providerModel: string | undefined;

    try {
      const response = await provider.generateImpactAnalysis({
        traceId,
        analysisRunId,
        attempt,
        systemPrompt: IMPACT_ANALYSIS_SYSTEM_PROMPT,
        modelInput,
        validationFeedback,
      });
      providerModel = response.model;
      const durationMs = response.durationMs;

      const structural = impactAnalysisOutputSchema.safeParse(response.rawOutput);
      if (!structural.success) {
        category = "INVALID_OUTPUT_SCHEMA";
        safeErrors = summarizeOutputSchemaErrors(structural.error);
      } else {
        const semantic = validateImpactAnalysisSemantics(structural.data, modelInput);
        if (!semantic.valid) {
          category = "SEMANTIC_VALIDATION_FAILED";
          safeErrors = semantic.errors;
        } else {
          await persistSucceededAttempt({
            analysisId,
            traceId,
            actorUserId: actor.id,
            eventId: event.id,
            durationMs,
            providerModel,
            output: structural.data,
            modelInput,
          });
          logAnalysisEvent("analysis.succeeded", {
            traceId,
            analysisRunId,
            analysisId,
            attempt,
            eventId: event.id,
            requestedById: actor.id,
            aiMode,
            provider: provider.name,
            model: providerModel,
            durationMs,
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
      }

      await persistFailedAttempt({
        analysisId,
        category,
        durationMs,
        validationErrors: safeErrors,
        providerModel,
      });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      category = classifyProviderError(error);
      await persistFailedAttempt({
        analysisId,
        category,
        durationMs,
        validationErrors: safeErrors,
        providerModel,
      });
    }

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
