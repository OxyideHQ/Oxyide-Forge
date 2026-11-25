-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "consumedAt" TIMESTAMP(3),
ADD COLUMN     "supersededBy" TEXT;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_supersededBy_key" ON "RefreshToken"("supersededBy");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_supersededBy_fkey" FOREIGN KEY ("supersededBy") REFERENCES "RefreshToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
