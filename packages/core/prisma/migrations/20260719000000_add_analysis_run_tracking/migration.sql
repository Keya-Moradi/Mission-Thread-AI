-- AlterTable
ALTER TABLE "ImpactAnalysis" ADD COLUMN     "analysisRunId" TEXT NOT NULL,
ADD COLUMN     "requestedById" TEXT NOT NULL,
ADD COLUMN     "validationErrors" JSONB,
ADD COLUMN     "validationPassed" BOOLEAN;

-- CreateIndex
CREATE INDEX "ImpactAnalysis_analysisRunId_idx" ON "ImpactAnalysis"("analysisRunId");

-- CreateIndex
CREATE INDEX "ImpactAnalysis_requestedById_idx" ON "ImpactAnalysis"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "ImpactAnalysis_analysisRunId_attempt_key" ON "ImpactAnalysis"("analysisRunId", "attempt");

-- AddForeignKey
ALTER TABLE "ImpactAnalysis" ADD CONSTRAINT "ImpactAnalysis_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

