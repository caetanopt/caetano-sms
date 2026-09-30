import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  aggregateWindow,
  METRIC_WINDOWS,
  type MetricWindow,
  type OperationalMetrics,
  type QueueMetrics,
  type SendWindowMetrics,
  toEmf,
} from "@/features/observability/metrics";
import { FACTOR_RECOVERY_PER_SECOND } from "@/features/rate-limit/token-bucket";
import { getSmsJobQueueConfig, type SmsJobQueueConfig } from "@/lib/aws/sqs-config";
import { prisma } from "@/lib/db/prisma";
import { getSmsRuntimeConfig, type SmsRuntimeConfig } from "@/lib/sms/config";
import { STALE_MS } from "./campaigns/engine";
import { quotaUsage } from "./send-rate";
import { getCampaignLimits } from "@/features/campaigns/limits";
import { CONFIRMER_INACTIVE_HALT_CODE, effectiveDailyLimit, USER_QUOTA_HALT_CODE } from "@/features/rate-limit/quota";
import { lisbonDayWindow } from "@/lib/time/lisbon";

/** Amostras de latência por janela (as mais recentes): limita o custo da consulta. */
const LATENCY_SAMPLE_LIMIT = 5_000;
const QUEUE_TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60_000;

export type QueueAttributesReader = (queueUrl: string) => Promise<Record<string, string>>;

export type ObservabilityDeps = {
  now: () => Date;
  runtime: SmsRuntimeConfig;
  queue: SmsJobQueueConfig;
  /** Defeito da quota diária por utilizador (SMS_USER_DAILY_PARTS_LIMIT). */
  userDailyParts: number;
  /** Só chamado com SMS_JOB_QUEUE=sqs (requer sqs:GetQueueAttributes). */
  readQueueAttributes?: QueueAttributesReader;
};

export function defaultObservabilityDeps(): ObservabilityDeps {
  const queue = getSmsJobQueueConfig();
  let client: SQSClient | null = null;
  return {
    now: () => new Date(),
    runtime: getSmsRuntimeConfig(),
    queue,
    userDailyParts: getCampaignLimits().userDailyParts,
    readQueueAttributes:
      queue.kind === "sqs"
        ? async (queueUrl) => {
            client ??= new SQSClient({ region: queue.region, maxAttempts: 1 });
            const result = await client.send(
              new GetQueueAttributesCommand({
                QueueUrl: queueUrl,
                AttributeNames: [
                  "ApproximateNumberOfMessages",
                  "ApproximateNumberOfMessagesNotVisible",
                  "ApproximateNumberOfMessagesDelayed",
                ],
              }),
            );
            return result.Attributes ?? {};
          }
        : undefined,
  };
}

async function sendWindow(since: Date): Promise<SendWindowMetrics> {
  const [groups, latencies] = await Promise.all([
    prisma.smsMessage.groupBy({
      by: ["status", "errorCode", "dryRun"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.smsMessage.findMany({
      where: { createdAt: { gte: since }, providerLatencyMs: { not: null } },
      orderBy: { createdAt: "desc" },
      take: LATENCY_SAMPLE_LIMIT,
      select: { providerLatencyMs: true },
    }),
  ]);
  return aggregateWindow(
    groups.map((g) => ({ status: g.status, errorCode: g.errorCode, dryRun: g.dryRun, count: g._count._all })),
    latencies.map((row) => row.providerLatencyMs ?? 0),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error: unknown) => (clearTimeout(timer), reject(error)),
    );
  });
}

async function queueMetrics(deps: ObservabilityDeps): Promise<QueueMetrics> {
  if (deps.queue.kind !== "sqs") return { kind: "direct" };
  if (!deps.readQueueAttributes) return { kind: "sqs", up: false };
  const read = deps.readQueueAttributes;
  const num = (attrs: Record<string, string>, key: string) => {
    const value = Number(attrs[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  try {
    const [jobs, dlq] = await Promise.all([
      withTimeout(read(deps.queue.queueUrl), QUEUE_TIMEOUT_MS),
      deps.queue.dlqUrl ? withTimeout(read(deps.queue.dlqUrl), QUEUE_TIMEOUT_MS) : Promise.resolve(null),
    ]);
    return {
      kind: "sqs",
      up: true,
      visible: num(jobs, "ApproximateNumberOfMessages"),
      inFlight: num(jobs, "ApproximateNumberOfMessagesNotVisible"),
      delayed: num(jobs, "ApproximateNumberOfMessagesDelayed"),
      dlqVisible: dlq ? num(dlq, "ApproximateNumberOfMessages") : null,
    };
  } catch {
    return { kind: "sqs", up: false };
  }
}

/**
 * Utilizadores ativos que esgotaram hoje a quota. Exclui quem tem limite 0 (decisão de um
 * administrador, não esgotamento): senão a métrica nunca voltaria a 0 e os alarmes perdiam valor.
 */
async function usersExhaustedToday(deps: ObservabilityDeps, now: Date) {
  const { start } = lisbonDayWindow(now);
  const senders = await prisma.smsMessage.groupBy({ by: ["createdById"], where: { createdAt: { gte: start } } });
  const ids = senders.map((row) => row.createdById);
  if (ids.length === 0) return 0;
  const users = await prisma.user.findMany({ where: { id: { in: ids }, isActive: true }, select: { id: true, dailyPartsLimit: true } });
  let exhausted = 0;
  for (const user of users) {
    const limit = effectiveDailyLimit(user.dailyPartsLimit, deps.userDailyParts);
    if (limit > 0 && limit - (await quotaUsage(prisma, user.id, now)) <= 0) exhausted += 1;
  }
  return exhausted;
}

function campaignsHaltedByQuota24h(now: Date) {
  const since = new Date(now.getTime() - DAY_MS);
  return Promise.all(
    [USER_QUOTA_HALT_CODE, CONFIRMER_INACTIVE_HALT_CODE].map((code) =>
      prisma.auditLog.count({ where: { action: "CAMPAIGN_HALTED", createdAt: { gte: since }, metadataJson: { path: ["reason"], equals: code } } }),
    ),
  ).then((counts) => counts.reduce((sum, count) => sum + count, 0));
}

/**
 * Snapshot das métricas operacionais a partir da base de dados (fonte de verdade partilhada
 * por todas as instâncias) e, com SQS, dos atributos da fila. Só leituras; nunca envia.
 */
export async function collectOperationalMetrics(deps: ObservabilityDeps = defaultObservabilityDeps()): Promise<OperationalMetrics> {
  const now = deps.now();
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const windowEntries = Object.entries(METRIC_WINDOWS) as [MetricWindow, number][];

  const [windowValues, sending, paused, pausedWithError, failedOrPartial24h, stuckProcessing, unknown, awaitingReceiptOver24h, throttledBuckets, slowedRows, queue, exhausted, haltedByQuota] =
    await Promise.all([
      Promise.all(windowEntries.map(([, ms]) => sendWindow(ago(ms)))),
      prisma.campaign.count({ where: { status: "SENDING", pausedAt: null } }),
      prisma.campaign.count({ where: { status: { in: ["READY", "SENDING"] }, pausedAt: { not: null } } }),
      // Pausas automáticas (circuit breaker) não têm autor.
      prisma.campaign.count({ where: { status: { in: ["READY", "SENDING"] }, pausedAt: { not: null }, pausedById: null } }),
      prisma.campaign.count({ where: { status: { in: ["FAILED", "PARTIAL"] }, finishedAt: { gte: ago(DAY_MS) } } }),
      prisma.campaignRecipient.count({ where: { status: "PROCESSING", claimedAt: { lt: ago(STALE_MS) } } }),
      prisma.campaignRecipient.count({ where: { status: "UNKNOWN" } }),
      prisma.smsMessage.count({
        where: { dryRun: false, status: { in: ["ACCEPTED", "QUEUED", "SENT"] }, sentAt: { lt: ago(DAY_MS), gte: ago(7 * DAY_MS) } },
      }),
      prisma.sendRateBucket.count({ where: { throttledAt: { gte: ago(METRIC_WINDOWS["15m"]) } } }),
      prisma.sendRateBucket.findMany({ where: { rateFactor: { lt: 1 } }, select: { rateFactor: true, updatedAt: true } }),
      queueMetrics(deps),
      usersExhaustedToday(deps, now),
      campaignsHaltedByQuota24h(now),
    ]);

  // O multiplicador guardado é o do último acesso: projetar a recuperação até agora.
  const bucketsSlowed = slowedRows.filter(
    (row) => row.rateFactor + (FACTOR_RECOVERY_PER_SECOND * (now.getTime() - row.updatedAt.getTime())) / 1000 < 1,
  ).length;

  return {
    generatedAt: now,
    mode: deps.runtime.mode,
    provider: deps.runtime.provider,
    windows: Object.fromEntries(windowEntries.map(([key], i) => [key, windowValues[i]])) as Record<MetricWindow, SendWindowMetrics>,
    campaigns: { sending, paused, pausedWithError, failedOrPartial24h },
    recipients: { stuckProcessing, unknown },
    awaitingReceiptOver24h,
    rate: { bucketsThrottled15m: throttledBuckets, bucketsSlowed },
    quota: { usersExhaustedToday: exhausted, campaignsHaltedByQuota24h: haltedByQuota },
    queue,
  };
}

/**
 * Snapshot em CloudWatch Embedded Metric Format: uma linha JSON no stdout que o CloudWatch
 * Logs converte em métricas (sem chamadas à AWS nem dependências). Correr num só processo.
 */
export async function emitEmfSnapshot(
  namespace: string,
  write: (line: string) => void = (line) => console.info(line),
  deps: ObservabilityDeps = defaultObservabilityDeps(),
) {
  write(JSON.stringify(toEmf(await collectOperationalMetrics(deps), namespace)));
}
