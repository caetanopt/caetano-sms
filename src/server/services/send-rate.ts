import type { Prisma } from "@/generated/prisma/client";
import { bucketsFor, type SendRateConfig } from "@/features/rate-limit/rules";
import { initialBucket, penalize, tryConsume, type BucketState } from "@/features/rate-limit/token-bucket";
import { prisma } from "@/lib/db/prisma";

/**
 * Rate limiting de envios (CLAUDE.md §19), partilhado por campanhas e envio individual:
 * - global: SMS_MAX_SENDS_PER_MINUTE mensagens por minuto;
 * - token bucket de partes por segundo (MPS) por identidade de origem e por (origem, país),
 *   que abranda automaticamente após THROTTLED da AWS.
 *
 * Exceção documentada à regra "SQL só através do ORM" (§28): usa-se
 * `pg_advisory_xact_lock` para serializar a verificação "contar e reservar" entre
 * processos/pedidos concorrentes; o Prisma não tem equivalente. O lock é libertado
 * automaticamente no fim da transação. Não recebe input do utilizador.
 */
const SEND_RATE_LOCK_KEY = 58_231_907;
const WINDOW_MS = 60_000;

type Tx = Prisma.TransactionClient;

async function lockAndCount(tx: Tx, now: Date) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEND_RATE_LOCK_KEY})`;
  const since = new Date(now.getTime() - WINDOW_MS);
  const [messages, inFlight, oldest] = await Promise.all([
    tx.smsMessage.count({ where: { createdAt: { gt: since } } }),
    // Reservas recentes cujo envio pode ainda não ter criado o SmsMessage (conservador).
    // Reservas abandonadas saem da janela e não bloqueiam os envios.
    tx.campaignRecipient.count({ where: { status: "PROCESSING", claimedAt: { gt: since } } }),
    tx.smsMessage.findFirst({ where: { createdAt: { gt: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const retryAfterMs = oldest ? Math.max(1_000, oldest.createdAt.getTime() + WINDOW_MS - now.getTime()) : 1_000;
  return { used: messages + inFlight, retryAfterMs };
}

export type SendRateLimits = {
  maxPerMinute: number;
  rate: SendRateConfig;
  /** Identifica a identidade de origem atual (hash, ver `currentOrigin`). */
  originKey: string;
};

/** Destino e custo (partes estimadas) do envio a reservar. */
export type SendTarget = { phoneE164: string; segments: number };

export type RateCheck =
  | { ok: true }
  | { ok: false; retryAfterMs: number; limit: "per_minute" | "mps"; label?: string };

type BucketRow = { key: string; tokens: number; rateFactor: number; updatedAt: Date };

function toState(row: BucketRow | undefined, fallback: () => BucketState): BucketState {
  return row ? { tokens: row.tokens, rateFactor: row.rateFactor, updatedAt: row.updatedAt } : fallback();
}

/**
 * Consome `segments` tokens de todos os baldes do destino, ou nenhum (tudo-ou-nada).
 * Tem de correr dentro da transação que detém o lock.
 */
async function consumeBuckets(tx: Tx, target: SendTarget, limits: SendRateLimits, now: Date): Promise<RateCheck> {
  const buckets = bucketsFor({ originKey: limits.originKey, phoneE164: target.phoneE164 }, limits.rate);
  const rows = await tx.sendRateBucket.findMany({ where: { key: { in: buckets.map((b) => b.key) } } });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const cost = Math.max(1, target.segments);

  const next: { key: string; state: BucketState }[] = [];
  let blocked: { retryAfterMs: number; label: string } | null = null;
  for (const bucket of buckets) {
    const state = toState(byKey.get(bucket.key), () => initialBucket(bucket.rule, now));
    const result = tryConsume(state, bucket.rule, cost, now);
    if (!result.ok) {
      if (!blocked || result.retryAfterMs > blocked.retryAfterMs) blocked = { retryAfterMs: result.retryAfterMs, label: bucket.label };
      continue;
    }
    next.push({ key: bucket.key, state: result.state });
  }
  if (blocked) return { ok: false, retryAfterMs: Math.max(100, blocked.retryAfterMs), limit: "mps", label: blocked.label };

  for (const { key, state } of next) {
    await tx.sendRateBucket.upsert({
      where: { key },
      create: { key, tokens: state.tokens, rateFactor: state.rateFactor, updatedAt: state.updatedAt },
      update: { tokens: state.tokens, rateFactor: state.rateFactor, updatedAt: state.updatedAt },
    });
  }
  return { ok: true };
}

async function reserve(tx: Tx, target: SendTarget, limits: SendRateLimits, now: Date): Promise<RateCheck> {
  const { used, retryAfterMs } = await lockAndCount(tx, now);
  if (used >= limits.maxPerMinute) return { ok: false, retryAfterMs, limit: "per_minute" };
  return consumeBuckets(tx, target, limits, now);
}

/**
 * Reserva capacidade para um envio individual (limite por minuto + MPS). A reserva é
 * consumida mesmo que o envio acabe por não acontecer (conservador).
 */
export async function reserveSendCapacity(target: SendTarget, limits: SendRateLimits, now = new Date()): Promise<RateCheck> {
  return prisma.$transaction((tx) => reserve(tx, target, limits, now));
}

/** THROTTLED da AWS: esvazia e abranda os baldes do destino (AIMD, ver token-bucket.ts). */
export async function recordProviderThrottle(
  target: Pick<SendTarget, "phoneE164">,
  limits: Pick<SendRateLimits, "rate" | "originKey">,
  now = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEND_RATE_LOCK_KEY})`;
    const buckets = bucketsFor({ originKey: limits.originKey, phoneE164: target.phoneE164 }, limits.rate);
    const rows = await tx.sendRateBucket.findMany({ where: { key: { in: buckets.map((b) => b.key) } } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    for (const bucket of buckets) {
      const state = penalize(toState(byKey.get(bucket.key), () => initialBucket(bucket.rule, now)), bucket.rule, now);
      await tx.sendRateBucket.upsert({
        where: { key: bucket.key },
        create: { key: bucket.key, tokens: state.tokens, rateFactor: state.rateFactor, updatedAt: now, throttledAt: now },
        update: { tokens: state.tokens, rateFactor: state.rateFactor, updatedAt: now, throttledAt: now },
      });
    }
  });
}

export type ClaimedRecipient = {
  id: string;
  contactId: string | null;
  renderedBody: string | null;
  segments: number | null;
  attempt: number;
  retries: number;
  claimToken: string;
};

export type ClaimResult =
  | { kind: "claimed"; recipient: ClaimedRecipient }
  | { kind: "rate_limited"; retryAfterMs: number; limit: "per_minute" | "mps"; label?: string }
  | { kind: "none" };

/**
 * Reserva o próximo destinatário PENDING de uma campanha, sob o lock de rate limit:
 * a contagem, o consumo de MPS e a reserva são atómicos em relação a outros passos/campanhas.
 */
export async function claimNextRecipient(input: {
  campaignId: string;
  claimToken: string;
  limits: SendRateLimits;
  now: Date;
}): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    const { used, retryAfterMs } = await lockAndCount(tx, input.now);
    if (used >= input.limits.maxPerMinute) return { kind: "rate_limited", retryAfterMs, limit: "per_minute" };

    const candidate = await tx.campaignRecipient.findFirst({
      where: {
        campaignId: input.campaignId,
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, segments: true, contact: { select: { phoneE164: true } } },
    });
    if (!candidate) return { kind: "none" };

    // Sem contacto/texto o envio não chega a acontecer (é ignorado/falhado): não consome MPS.
    if (candidate.contact && candidate.segments !== null) {
      const rate = await consumeBuckets(tx, { phoneE164: candidate.contact.phoneE164, segments: candidate.segments }, input.limits, input.now);
      if (!rate.ok) return { kind: "rate_limited", retryAfterMs: rate.retryAfterMs, limit: rate.limit, label: rate.label };
    }

    const { count } = await tx.campaignRecipient.updateMany({
      where: { id: candidate.id, status: "PENDING" },
      data: { status: "PROCESSING", claimToken: input.claimToken, claimedAt: input.now },
    });
    if (count === 0) return { kind: "none" };

    const recipient = await tx.campaignRecipient.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { id: true, contactId: true, renderedBody: true, segments: true, attempt: true, retries: true },
    });
    return { kind: "claimed", recipient: { ...recipient, claimToken: input.claimToken } };
  });
}
