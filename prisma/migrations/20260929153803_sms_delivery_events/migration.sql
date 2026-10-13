-- AlterTable
ALTER TABLE "SmsMessage" ADD COLUMN     "lastEventAt" TIMESTAMP(3),
ADD COLUMN     "lastEventType" TEXT;

-- CreateTable
CREATE TABLE "SmsDeliveryEvent" (
    "id" TEXT NOT NULL,
    "snsMessageId" TEXT NOT NULL,
    "awsMessageId" TEXT NOT NULL,
    "smsMessageId" TEXT,
    "eventType" TEXT NOT NULL,
    "messageStatus" TEXT,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "eventAt" TIMESTAMP(3),
    "priceUsd" DECIMAL(12,6),
    "applied" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsDeliveryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SmsDeliveryEvent_snsMessageId_key" ON "SmsDeliveryEvent"("snsMessageId");

-- CreateIndex
CREATE INDEX "SmsDeliveryEvent_awsMessageId_idx" ON "SmsDeliveryEvent"("awsMessageId");

-- CreateIndex
CREATE INDEX "SmsDeliveryEvent_createdAt_idx" ON "SmsDeliveryEvent"("createdAt");

-- AddForeignKey
ALTER TABLE "SmsDeliveryEvent" ADD CONSTRAINT "SmsDeliveryEvent_smsMessageId_fkey" FOREIGN KEY ("smsMessageId") REFERENCES "SmsMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
