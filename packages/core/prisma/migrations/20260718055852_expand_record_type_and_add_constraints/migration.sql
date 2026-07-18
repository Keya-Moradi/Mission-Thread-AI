-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "RecordType" ADD VALUE 'DEPENDENCY';
ALTER TYPE "RecordType" ADD VALUE 'IMPACT_ANALYSIS';
ALTER TYPE "RecordType" ADD VALUE 'MITIGATION_OPTION';
ALTER TYPE "RecordType" ADD VALUE 'PROPOSED_CHANGE';
ALTER TYPE "RecordType" ADD VALUE 'DECISION';
ALTER TYPE "RecordType" ADD VALUE 'SOURCE_REFERENCE';

-- CreateIndex
CREATE INDEX "Decision_traceId_idx" ON "Decision"("traceId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceReference_impactAnalysisId_recordType_recordId_key" ON "SourceReference"("impactAnalysisId", "recordType", "recordId");

