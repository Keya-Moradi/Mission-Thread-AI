-- AlterTable
ALTER TABLE "ImpactAnalysis" ADD COLUMN     "readinessSnapshot" JSONB;

-- AlterTable
ALTER TABLE "SourceReference" ADD COLUMN     "citationContexts" JSONB,
ADD COLUMN     "wasCited" BOOLEAN NOT NULL DEFAULT false;

