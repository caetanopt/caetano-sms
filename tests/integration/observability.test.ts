import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "@/app/api/metrics/route";
import { prisma } from "@/lib/db/prisma";
import { getSmsRuntimeConfig } from "@/lib/sms/config";
import { FakeSmsProvider } from "@/lib/sms/fake-provider";
import { STALE_MS } from "@/server/services/campaigns/engine";
import { prismaManualSendStore } from "@/server/repositories/prisma-manual-send-store";
import { collectOperationalMetrics, emitEmfSnapshot, type ObservabilityDeps } from "@/server/services/observability";
import { dispatchSms } from "@/server/services/sms-dispatch";
import { createActors, resetDatabase } from "./helpers";

const now = new Date();
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
let userId: string;
let seq = 0;

const SQS = {
  kind: "sqs",
  region: "eu-west-1",
  queueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/sms-jobs",
  dlqUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/sms-jobs-dlq",
  fifo: false,
  maxInFlight: 10,
  visibilityTimeoutSeconds: 60,
} as const;

function deps(overrides: Partial<ObservabilityDeps> = {}): ObservabilityDeps {
  return { now: () => now, runtime: getSmsRuntimeConfig({ SMS_PROVIDER: "fake" }), queue: { kind: "direct" }, ...overrides };
}

async function message(data: { status: string; createdAt: Date; errorCode?: string; latency?: number; dryRun?: boolean; sentAt?: Date }) {
  seq += 1;
  await prisma.smsMessage.create({
    data: {
      idempotencyKey: `obs-${seq}`,
      destinationPhoneE164: "+351912345678",
      messageType: "TRANSACTIONAL",
      body: "Olá",
      provider: "aws",
      status: data.status as "ACCEPTED",
      errorCode: data.errorCode,
      providerLatencyMs: data.latency,
      dryRun: data.dryRun ?? false,
      sentAt: data.sentAt,
      createdAt: data.createdAt,
      createdById: userId,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  userId = (await createActors()).admin.id;
});
afterEach(() => {
  delete process.env.METRICS_TOKEN;
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("collectOperationalMetrics", () => {
  it("aggregates sends per window, latency, campaigns, stuck recipients and MPS buckets", async () => {
    await message({ status: "ACCEPTED", createdAt: minutesAgo(1), latency: 100 });
    await message({ status: "DELIVERED", createdAt: minutesAgo(5), latency: 300 });
    await message({ status: "FAILED", errorCode: "THROTTLED", createdAt: minutesAgo(10), latency: 50 });
    await message({ status: "UNKNOWN", errorCode: "UNKNOWN", createdAt: minutesAgo(30) });
    await message({ status: "ACCEPTED", createdAt: minutesAgo(120), dryRun: true, latency: 5 });
    // Aceite há 2 dias sem recibo final.
    await message({ status: "ACCEPTED", createdAt: minutesAgo(2 * 24 * 60), sentAt: minutesAgo(2 * 24 * 60) });

    const base = { messageType: "TRANSACTIONAL" as const, messageBody: "x", createdById: userId };
    const auto = await prisma.campaign.create({ data: { ...base, name: "Auto", status: "SENDING", pausedAt: now, lastError: "Envio parado" } });
    await prisma.campaign.create({ data: { ...base, name: "Manual", status: "SENDING", pausedAt: now, pausedById: userId } });
    await prisma.campaign.create({ data: { ...base, name: "Ativa", status: "SENDING" } });
    await prisma.campaign.create({ data: { ...base, name: "Parcial", status: "PARTIAL", finishedAt: minutesAgo(60) } });
    await prisma.campaignRecipient.create({
      data: { campaignId: auto.id, status: "PROCESSING", claimToken: "t", claimedAt: new Date(now.getTime() - STALE_MS - 60_000) },
    });
    await prisma.sendRateBucket.create({ data: { key: "a", tokens: 0, rateFactor: 0.5, updatedAt: now, throttledAt: now } });
    await prisma.sendRateBucket.create({ data: { key: "b", tokens: 1, rateFactor: 0.5, updatedAt: minutesAgo(10) } }); // já recuperou

    const metrics = await collectOperationalMetrics(deps());
    expect(metrics.windows["15m"]).toMatchObject({
      total: 3,
      throttled: 1,
      byOutcome: { accepted: 2, failed: 1, uncertain: 0 },
      latencyMs: { samples: 3, p50: 100, p95: 300, max: 300 },
    });
    expect(metrics.windows["1h"]).toMatchObject({ total: 4, byOutcome: { uncertain: 1 }, errors: { THROTTLED: 1, UNKNOWN: 1 } });
    expect(metrics.windows["24h"]).toMatchObject({ total: 5, dryRun: 1 });
    expect(metrics.campaigns).toEqual({ sending: 1, paused: 2, pausedWithError: 1, failedOrPartial24h: 1 });
    expect(metrics.recipients).toEqual({ stuckProcessing: 1, unknown: 0 });
    expect(metrics.awaitingReceiptOver24h).toBe(1);
    expect(metrics.rate).toEqual({ bucketsThrottled15m: 1, bucketsSlowed: 1 });
    expect(metrics.queue).toEqual({ kind: "direct" });
  });

  it("reads SQS queue depth, and reports the queue as down on error or timeout", async () => {
    const reads: string[] = [];
    const up = await collectOperationalMetrics(
      deps({
        queue: SQS,
        readQueueAttributes: async (url): Promise<Record<string, string>> => {
          reads.push(url);
          return url.endsWith("-dlq")
            ? { ApproximateNumberOfMessages: "2" }
            : { ApproximateNumberOfMessages: "7", ApproximateNumberOfMessagesNotVisible: "3", ApproximateNumberOfMessagesDelayed: "1" };
        },
      }),
    );
    expect(up.queue).toEqual({ kind: "sqs", up: true, visible: 7, inFlight: 3, delayed: 1, dlqVisible: 2 });
    expect(reads.sort()).toEqual([SQS.queueUrl, SQS.dlqUrl]);

    const failing = await collectOperationalMetrics(deps({ queue: SQS, readQueueAttributes: async () => Promise.reject(new Error("AccessDenied")) }));
    expect(failing.queue).toEqual({ kind: "sqs", up: false });
    const hanging = await collectOperationalMetrics(deps({ queue: SQS, readQueueAttributes: () => new Promise(() => {}) }));
    expect(hanging.queue).toEqual({ kind: "sqs", up: false });
  }, 10_000);

  it("stores the provider latency of each send", async () => {
    await dispatchSms(
      {
        message: {
          idempotencyKey: "lat-1",
          contactId: null,
          destinationPhoneE164: "+351912345678",
          messageType: "TRANSACTIONAL",
          body: "Olá",
          encodingEstimate: "GSM_7",
          segmentCountEstimate: 1,
          templateId: null,
          campaignId: null,
          createdById: userId,
        },
        source: "manual",
        auditMetadata: null,
      },
      {
        store: prismaManualSendStore,
        config: getSmsRuntimeConfig({ SMS_PROVIDER: "fake" }),
        provider: new FakeSmsProvider({ delayMs: 20 }),
        logger: { log: () => {} },
        now: () => new Date(),
      },
    );
    const row = await prisma.smsMessage.findUniqueOrThrow({ where: { idempotencyKey: "lat-1" } });
    expect(row.providerLatencyMs).toBeGreaterThanOrEqual(15);
  });

  it("emits a CloudWatch EMF line without PII", async () => {
    await message({ status: "ACCEPTED", createdAt: minutesAgo(1), latency: 80 });
    const lines: string[] = [];
    await emitEmfSnapshot("SmsApp", (line) => lines.push(line), deps());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ Mode: "TEST", Accepted15m: 1, ProviderLatencyP95Ms: 80 });
    expect(lines[0]).not.toContain("912345678");
  });
});

describe("GET /api/metrics", () => {
  const token = "m".repeat(40);
  const call = (authorization?: string) =>
    GET(new Request("http://localhost/api/metrics", { headers: authorization ? { authorization } : {} }));

  it("is disabled without METRICS_TOKEN", async () => {
    expect((await call(`Bearer ${token}`)).status).toBe(404);
  });

  it("requires the bearer token and returns Prometheus text without PII", async () => {
    process.env.METRICS_TOKEN = token;
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);

    await message({ status: "ACCEPTED", createdAt: minutesAgo(1), latency: 42 });
    const response = await call(`Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain('sms_messages_window{window="15m",outcome="accepted"} 1');
    expect(body).toContain('sms_provider_latency_ms{window="15m",quantile="0.5"} 42');
    expect(body).not.toContain("912345678");
  });

  it("fails safely with an invalid token configuration", async () => {
    process.env.METRICS_TOKEN = "short";
    expect((await call("Bearer short")).status).toBe(503);
  });
});
