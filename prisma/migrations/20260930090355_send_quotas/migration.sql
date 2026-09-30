-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "maxSendsPerMinute" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "dailyPartsLimit" INTEGER;

-- CreateIndex
CREATE INDEX "SmsMessage_createdById_createdAt_idx" ON "SmsMessage"("createdById", "createdAt");

-- Intervalos garantidos também na base de dados (CLAUDE.md §18): null = defeito da aplicação.
ALTER TABLE "User" ADD CONSTRAINT "User_dailyPartsLimit_range"
  CHECK ("dailyPartsLimit" IS NULL OR ("dailyPartsLimit" >= 0 AND "dailyPartsLimit" <= 1000000));
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_maxSendsPerMinute_range"
  CHECK ("maxSendsPerMinute" IS NULL OR ("maxSendsPerMinute" >= 1 AND "maxSendsPerMinute" <= 10000));
