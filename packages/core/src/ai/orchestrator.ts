import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { entityIdSchema } from "../analysis/schemas";
import { buildAnalysisEvidence } from "../analysis/evidence";
import { evidenceRecordTypeSchema } from "../record-types";
import { ok, notFound, validationError, forbidden, type ServiceResult } from "../analysis/types";
import { createProviderFromEnv } from "./provider-factory";
import {
  buildModelInputProjection,
  checkModelInputSize,
  type ModelInputProjection,
} from "./model-input";
import { IMPACT_ANALYSIS_SYSTEM_PROMPT } from "./prompts/impact-analysis-system";
import { impactAnalysisOutputSchema, summarizeOutputSchemaErrors } from "./output-schema";
import { validateImpactAnalysisSemantics } from "./output-validation";
import { classifyProviderError, isRetryableCategory, type AiErrorCategory } from "./errors";
import { logAnalysisEvent } from "./logging";
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

async function persistFailedAttempt(
  analysisId: string,
  category: AiErrorCategory,
  durationMs: number,
  validationErrors: string[] | null,
): Promise<void> {
  await prisma.impactAnalysis.update({
    where: { id: analysisId },
    data: {
      status: "FAILED",
      validationPassed: false,
      validationErrors: validationErrors ?? undefined,
      errorCategory: category,
      durationMs,
    },
  });
}

async function persistSucceededAttempt(params: {
  analysisId: string;
  traceId: string;
  actorUserId: string;
  eventId: string;
  durationMs: number;
  output: import("./output-schema").ImpactAnalysisOutput;
  modelInput: ModelInputProjection;
}): Promise<void> {
  const { analysisId, traceId, actorUserId, eventId, durationMs, output, modelInput } = params;

  // Maps every allowlisted evidence record's ID -> recordType, so a model
  // output's sourceRecordIds (which only carries the ID) can be persisted
  // with the correct RecordType — safe to trust here because semantic
  // validation already confirmed every cited ID exists in this allowlist.
  const recordTypeById = new Map(
    modelInput.evidenceAllowlist.map((item) => [item.recordId, item.recordType]),
  );
  const summaryById = new Map(
    modelInput.evidenceAllowlist.map((item) => [item.recordId, item.summary]),
  );

  const citedIds = new Set<string>([
    ...output.sourceRecordIds,
    ...output.mitigationOptions.flatMap((option) => option.sourceRecordIds),
  ]);

  await prisma.$transaction(async (tx) => {
    await tx.impactAnalysis.update({
      where: { id: analysisId },
      data: {
        status: "SUCCEEDED",
        validationPassed: true,
        validationErrors: undefined,
        executiveSummary: output.executiveSummary,
        missionImpact: output.missionImpact,
        scheduleExposureDays: output.scheduleExposureDays,
        budgetExposureAmount: output.budgetExposureAmount,
        verificationGaps: output.verificationGaps,
        assumptions: output.assumptions,
        unknowns: output.unknowns,
        confidence: output.confidence,
        durationMs,
      },
    });

    for (const recordId of citedIds) {
      const recordType = recordTypeById.get(recordId);
      const parsedType = evidenceRecordTypeSchema.safeParse(recordType);
      if (!parsedType.success) continue; // already excluded by semantic validation; defensive only
      await tx.sourceReference.create({
        data: {
          impactAnalysisId: analysisId,
          recordId,
          recordType: parsedType.data,
          summary: summaryById.get(recordId) ?? "",
        },
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
 * the provider attempt lifecycle (create PENDING row -> audit start -> call
 * provider outside any transaction -> structural then semantic validation
 * -> persist). Retries at most once, only on a retryable failure category —
 * see errors.ts. Creates zero Decision/ProposedChange rows; this is Phase 4
 * only (analysis + mitigation options), never Phase 5's approval/apply
 * workflow. See docs/DECISIONS.md, "Phase 4 orchestration".
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

    await prisma.impactAnalysis.create({
      data: {
        id: analysisId,
        programEventId: event.id,
        analysisRunId,
        requestedById: actor.id,
        traceId,
        attempt,
        status: "PENDING",
        aiMode,
        provider: provider.name,
      },
    });

    await prisma.auditEvent.create({
      data: {
        traceId,
        actorUserId: actor.id,
        actorType: "USER",
        action: "ANALYSIS_STARTED",
        targetRecordId: analysisId,
        targetRecordType: "IMPACT_ANALYSIS",
        afterValue: { eventId: event.id, analysisRunId, attempt },
      },
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
          await prisma.impactAnalysis.update({
            where: { id: analysisId },
            data: { model: providerModel },
          });
          await persistSucceededAttempt({
            analysisId,
            traceId,
            actorUserId: actor.id,
            eventId: event.id,
            durationMs,
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

      await prisma.impactAnalysis.update({
        where: { id: analysisId },
        data: { model: providerModel },
      });
      await persistFailedAttempt(analysisId, category, durationMs, safeErrors);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      category = classifyProviderError(error);
      await persistFailedAttempt(analysisId, category, durationMs, safeErrors);
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
