-- CreateTable
CREATE TABLE "SendRateBucket" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "rateFactor" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "throttledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SendRateBucket_pkey" PRIMARY KEY ("key")
);
