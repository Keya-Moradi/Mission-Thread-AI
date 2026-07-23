-- DropIndex
DROP INDEX "Decision_mitigationOptionId_idx";

-- AlterTable
ALTER TABLE "Decision" ALTER COLUMN "rationale" SET NOT NULL;

-- AlterTable
ALTER TABLE "ProposedChange" ALTER COLUMN "targetRecordId" DROP NOT NULL,
ALTER COLUMN "targetRecordType" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Decision_mitigationOptionId_key" ON "Decision"("mitigationOptionId");

