-- AlterTable
ALTER TABLE "SmsMessage" ADD COLUMN     "dryRun" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "providerErrorName" TEXT,
ADD COLUMN     "providerRequestId" TEXT;
