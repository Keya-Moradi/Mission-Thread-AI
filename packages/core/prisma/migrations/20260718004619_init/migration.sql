-- CreateEnum
CREATE TYPE "Role" AS ENUM ('PROGRAM_MANAGER', 'ENGINEERING_LEAD', 'EXECUTIVE_VIEWER');

-- CreateEnum
CREATE TYPE "MilestoneStatus" AS ENUM ('NOT_STARTED', 'ON_TRACK', 'AT_RISK', 'DELAYED', 'COMPLETE');

-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('OPEN', 'MITIGATING', 'CLOSED');

-- CreateEnum
CREATE TYPE "TestOutcome" AS ENUM ('PASSED', 'FAILED', 'BLOCKED', 'NOT_RUN');

-- CreateEnum
CREATE TYPE "DefectSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DefectStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "EventType" AS ENUM ('SUPPLIER_DELAY', 'GENERAL_UPDATE');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "MitigationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED');

-- CreateEnum
CREATE TYPE "ApprovalState" AS ENUM ('APPROVED', 'REJECTED', 'REVISION_REQUESTED');

-- CreateEnum
CREATE TYPE "ProposedChangeType" AS ENUM ('MILESTONE_DATE', 'RISK_UPDATE', 'BUDGET_UPDATE', 'NEW_ACTION');

-- CreateEnum
CREATE TYPE "ProposedChangeStatus" AS ENUM ('PENDING', 'APPLIED');

-- CreateEnum
CREATE TYPE "AuditActor" AS ENUM ('USER', 'SYSTEM', 'AI');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('EVENT_RECORDED', 'ANALYSIS_STARTED', 'ANALYSIS_SUCCEEDED', 'ANALYSIS_FAILED', 'DECISION_RECORDED', 'CHANGES_APPLIED');

-- CreateEnum
CREATE TYPE "RecordType" AS ENUM ('PROGRAM', 'COMPONENT', 'REQUIREMENT', 'MILESTONE', 'RISK', 'SUPPLIER', 'TEST_CASE', 'DEFECT', 'BUDGET_ITEM', 'PROGRAM_EVENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Program" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Program_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Component" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subsystem" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "Component_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Requirement" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "Requirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequirementComponent" (
    "requirementId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,

    CONSTRAINT "RequirementComponent_pkey" PRIMARY KEY ("requirementId","componentId")
);

-- CreateTable
CREATE TABLE "Milestone" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plannedDate" TIMESTAMP(3) NOT NULL,
    "currentDate" TIMESTAMP(3) NOT NULL,
    "status" "MilestoneStatus" NOT NULL,

    CONSTRAINT "Milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dependency" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "fromMilestoneId" TEXT NOT NULL,
    "toMilestoneId" TEXT NOT NULL,

    CONSTRAINT "Dependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Risk" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "componentId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "RiskSeverity" NOT NULL,
    "probability" INTEGER NOT NULL,
    "impact" INTEGER NOT NULL,
    "status" "RiskStatus" NOT NULL,

    CONSTRAINT "Risk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestCase" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "outcome" "TestOutcome" NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestRequirement" (
    "testCaseId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,

    CONSTRAINT "TestRequirement_pkey" PRIMARY KEY ("testCaseId","requirementId")
);

-- CreateTable
CREATE TABLE "Defect" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "DefectSeverity" NOT NULL,
    "status" "DefectStatus" NOT NULL,
    "relatedTestCaseId" TEXT,

    CONSTRAINT "Defect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BudgetItem" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "componentId" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "plannedAmount" DECIMAL(12,2) NOT NULL,
    "actualAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',

    CONSTRAINT "BudgetItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramEvent" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "eventType" "EventType" NOT NULL,
    "componentId" TEXT,
    "supplierId" TEXT,
    "originalDate" TIMESTAMP(3),
    "revisedDate" TIMESTAMP(3),
    "delayDays" INTEGER,
    "reason" TEXT,
    "confidence" "ConfidenceLevel",
    "quantity" INTEGER,
    "rawNotes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImpactAnalysis" (
    "id" TEXT NOT NULL,
    "programEventId" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL,
    "aiMode" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "executiveSummary" TEXT,
    "missionImpact" TEXT,
    "scheduleExposureDays" INTEGER,
    "budgetExposureAmount" DECIMAL(12,2),
    "verificationGaps" JSONB,
    "assumptions" JSONB,
    "unknowns" JSONB,
    "confidence" "ConfidenceLevel",
    "errorCategory" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpactAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SourceReference" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "recordType" "RecordType" NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourceReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MitigationOption" (
    "id" TEXT NOT NULL,
    "impactAnalysisId" TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tradeoffs" TEXT NOT NULL,
    "costImpact" DECIMAL(12,2),
    "scheduleImpact" INTEGER,
    "isRecommended" BOOLEAN NOT NULL DEFAULT false,
    "status" "MitigationStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "MitigationOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposedChange" (
    "id" TEXT NOT NULL,
    "mitigationOptionId" TEXT NOT NULL,
    "changeType" "ProposedChangeType" NOT NULL,
    "targetRecordId" TEXT NOT NULL,
    "targetRecordType" "RecordType" NOT NULL,
    "oldValue" JSONB NOT NULL,
    "newValue" JSONB NOT NULL,
    "status" "ProposedChangeStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ProposedChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Decision" (
    "id" TEXT NOT NULL,
    "mitigationOptionId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "verdict" "ApprovalState" NOT NULL,
    "rationale" TEXT,
    "traceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" "AuditActor" NOT NULL,
    "action" "AuditAction" NOT NULL,
    "targetRecordId" TEXT,
    "targetRecordType" "RecordType",
    "decisionId" TEXT,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "Component_programId_idx" ON "Component"("programId");

-- CreateIndex
CREATE INDEX "Requirement_programId_idx" ON "Requirement"("programId");

-- CreateIndex
CREATE INDEX "RequirementComponent_componentId_requirementId_idx" ON "RequirementComponent"("componentId", "requirementId");

-- CreateIndex
CREATE INDEX "Milestone_programId_idx" ON "Milestone"("programId");

-- CreateIndex
CREATE INDEX "Milestone_componentId_idx" ON "Milestone"("componentId");

-- CreateIndex
CREATE INDEX "Dependency_programId_idx" ON "Dependency"("programId");

-- CreateIndex
CREATE INDEX "Dependency_toMilestoneId_idx" ON "Dependency"("toMilestoneId");

-- CreateIndex
CREATE UNIQUE INDEX "Dependency_fromMilestoneId_toMilestoneId_key" ON "Dependency"("fromMilestoneId", "toMilestoneId");

-- CreateIndex
CREATE INDEX "Risk_programId_idx" ON "Risk"("programId");

-- CreateIndex
CREATE INDEX "Supplier_programId_idx" ON "Supplier"("programId");

-- CreateIndex
CREATE INDEX "TestCase_programId_idx" ON "TestCase"("programId");

-- CreateIndex
CREATE INDEX "TestCase_outcome_idx" ON "TestCase"("outcome");

-- CreateIndex
CREATE INDEX "TestRequirement_requirementId_testCaseId_idx" ON "TestRequirement"("requirementId", "testCaseId");

-- CreateIndex
CREATE INDEX "Defect_programId_idx" ON "Defect"("programId");

-- CreateIndex
CREATE INDEX "BudgetItem_programId_idx" ON "BudgetItem"("programId");

-- CreateIndex
CREATE INDEX "ProgramEvent_programId_idx" ON "ProgramEvent"("programId");

-- CreateIndex
CREATE INDEX "ProgramEvent_eventType_idx" ON "ProgramEvent"("eventType");

-- CreateIndex
CREATE UNIQUE INDEX "ImpactAnalysis_traceId_key" ON "ImpactAnalysis"("traceId");

-- CreateIndex
CREATE INDEX "ImpactAnalysis_programEventId_idx" ON "ImpactAnalysis"("programEventId");

-- CreateIndex
CREATE INDEX "SourceReference_impactAnalysisId_idx" ON "SourceReference"("impactAnalysisId");

-- CreateIndex
CREATE INDEX "SourceReference_recordType_idx" ON "SourceReference"("recordType");

-- CreateIndex
CREATE INDEX "MitigationOption_status_idx" ON "MitigationOption"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MitigationOption_impactAnalysisId_optionIndex_key" ON "MitigationOption"("impactAnalysisId", "optionIndex");

-- CreateIndex
CREATE INDEX "ProposedChange_mitigationOptionId_idx" ON "ProposedChange"("mitigationOptionId");

-- CreateIndex
CREATE INDEX "ProposedChange_status_idx" ON "ProposedChange"("status");

-- CreateIndex
CREATE INDEX "Decision_mitigationOptionId_idx" ON "Decision"("mitigationOptionId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_traceId_idx" ON "AuditEvent"("traceId");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

-- AddForeignKey
ALTER TABLE "Component" ADD CONSTRAINT "Component_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Requirement" ADD CONSTRAINT "Requirement_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementComponent" ADD CONSTRAINT "RequirementComponent_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequirementComponent" ADD CONSTRAINT "RequirementComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Milestone" ADD CONSTRAINT "Milestone_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_fromMilestoneId_fkey" FOREIGN KEY ("fromMilestoneId") REFERENCES "Milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependency" ADD CONSTRAINT "Dependency_toMilestoneId_fkey" FOREIGN KEY ("toMilestoneId") REFERENCES "Milestone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestCase" ADD CONSTRAINT "TestCase_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRequirement" ADD CONSTRAINT "TestRequirement_testCaseId_fkey" FOREIGN KEY ("testCaseId") REFERENCES "TestCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestRequirement" ADD CONSTRAINT "TestRequirement_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "Requirement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_relatedTestCaseId_fkey" FOREIGN KEY ("relatedTestCaseId") REFERENCES "TestCase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BudgetItem" ADD CONSTRAINT "BudgetItem_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramEvent" ADD CONSTRAINT "ProgramEvent_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramEvent" ADD CONSTRAINT "ProgramEvent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramEvent" ADD CONSTRAINT "ProgramEvent_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramEvent" ADD CONSTRAINT "ProgramEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImpactAnalysis" ADD CONSTRAINT "ImpactAnalysis_programEventId_fkey" FOREIGN KEY ("programEventId") REFERENCES "ProgramEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceReference" ADD CONSTRAINT "SourceReference_impactAnalysisId_fkey" FOREIGN KEY ("impactAnalysisId") REFERENCES "ImpactAnalysis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MitigationOption" ADD CONSTRAINT "MitigationOption_impactAnalysisId_fkey" FOREIGN KEY ("impactAnalysisId") REFERENCES "ImpactAnalysis"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposedChange" ADD CONSTRAINT "ProposedChange_mitigationOptionId_fkey" FOREIGN KEY ("mitigationOptionId") REFERENCES "MitigationOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_mitigationOptionId_fkey" FOREIGN KEY ("mitigationOptionId") REFERENCES "MitigationOption"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
