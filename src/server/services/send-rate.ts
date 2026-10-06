import type { Prisma } from "@/generated/prisma/client";
import {
  CONFIRMER_INACTIVE_HALT_CODE,
  CONFIRMER_INACTIVE_HALT_MESSAGE,
  effectiveDailyLimit,
  effectivePerMinute,
  NOT_SENT_ERROR_CODES,
  quotaAllows,
  quotaState,
  USER_QUOTA_HALT_CODE,
  userQuotaHaltMessage,
  type QuotaState,
} from "@/features/rate-limit/quota";
import { campaignIdempotencyKey } from "@/features/campaigns/processing-rules";
import { bucketsFor, type SendRateConfig } from "@/features/rate-limit/rules";
import { initialBucket, penalize, tryConsume, type BucketState } from "@/features/rate-limit/token-bucket";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { lisbonDayWindow } from "@/lib/time/lisbon";

/**
 * Rate limiting e quotas de envio (CLAUDE.md §19), partilhados por campanhas e envio individual:
 * - global: SMS_MAX_SENDS_PER_MINUTE mensagens por minuto;
 * - por campanha: ritmo máximo opcional (Campaign.maxSendsPerMinute), que só aperta o global;
 * - por utilizador: quota diária de partes SMS (dia civil em Lisboa), paga por quem envia ou
 *   por quem confirmou a campanha;
 * - token bucket de partes por segundo (MPS) por identidade de origem e por (origem, país),
 *   que abranda automaticamente após THROTTLED da AWS.
 *
 * Exceção documentada à regra "SQL só através do ORM" (§28): usa-se
 * `pg_advisory_xact_lock` para serializar a verificação "contar e reservar" entre
 * processos/pedidos concorrentes; o Prisma não tem equivalente. O lock é libertado
 * automaticamente no fim da transação. Não recebe input do utilizador.
 *
 * Invariante: TODO o INSERT de SmsMessage participa neste lock — o envio individual dentro da
 * transação de reserva (exclusivo) e o envio de campanha com `lockSendRateShared` (partilhado:
 * as inserções não se bloqueiam entre si, mas nenhuma conclui enquanto uma reserva conta). As
 * contagens abaixo usam várias consultas em READ COMMITTED (cada uma com o seu snapshot); sem o
 * invariante, uma mensagem inserida entre duas delas podia ser contada zero vezes e a quota
 * diária ser ultrapassada por workers concorrentes.
 */
const SEND_RATE_LOCK_KEY = 58_231_907;
const WINDOW_MS = 60_000;
/** Reservas PROCESSING contam para o limite por minuto (60 s) e para a quota até este TTL (= STALE_MS do motor). */
export const RESERVATION_TTL_MS = 5 * 60_000;

type Tx = Prisma.TransactionClient;

/** Lock exclusivo "contar e reservar" (primeira instrução da transação). */
export async function lockSendRate(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SEND_RATE_LOCK_KEY})`;
}

/**
 * Lock partilhado para inserir um SmsMessage fora da transação de reserva (envio de campanha, já
 * reservado no claim). Primeira instrução da transação; ver o invariante no topo do ficheiro.
 */
export async function lockSendRateShared(tx: Tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${SEND_RATE_LOCK_KEY})`;
}

async function lockAndCount(tx: Tx, now: Date) {
  await lockSendRate(tx);
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

/** Mensagens por minuto de UMA campanha (só consultado quando a campanha tem ritmo próprio). */
async function countCampaignMinute(tx: Tx, campaignId: string, now: Date) {
  const since = new Date(now.getTime() - WINDOW_MS);
  const [messages, inFlight, oldest] = await Promise.all([
    tx.smsMessage.count({ where: { campaignId, createdAt: { gt: since } } }),
    tx.campaignRecipient.count({ where: { campaignId, status: "PROCESSING", claimedAt: { gt: since } } }),
    tx.smsMessage.findFirst({ where: { campaignId, createdAt: { gt: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const retryAfterMs = oldest ? Math.max(1_000, oldest.createdAt.getTime() + WINDOW_MS - now.getTime()) : 1_000;
  return { used: messages + inFlight, retryAfterMs };
}

export type SendRateLimits = {
  maxPerMinute: number;
  rate: SendRateConfig;
  /** Identifica a identidade de origem atual (hash, ver `currentOrigin`). */
  originKey: string;
  /** Defeito da quota diária (CampaignLimits.userDailyParts); o override vem de User.dailyPartsLimit lido na transação. */
  userDailyParts: number;
};

/** Destino e custo (partes estimadas) do envio a reservar. */
export type SendTarget = { phoneE164: string; segments: number };

export type RateBlocked =
  | { ok: false; limit: "per_minute" | "campaign_per_minute" | "mps"; retryAfterMs: number; label?: string; perMinute?: number }
  | { ok: false; limit: "user_quota"; retryAfterMs: number; quota: QuotaState; cost: number }
  | { ok: false; limit: "user_blocked"; retryAfterMs: number; reason: "inactive" | "missing" };
export type RateCheck = { ok: true } | RateBlocked;
type PayerCheck = { ok: true } | Extract<RateBlocked, { limit: "user_quota" | "user_blocked" }>;
type MpsCheck = { ok: true } | { ok: false; limit: "mps"; retryAfterMs: number; label: string };

/** Dados (sem tipos do ORM) para reservar capacidade e quota na mesma transação do INSERT do SmsMessage. */
export type CapacityReservation = { target: SendTarget; payerId: string; limits: SendRateLimits; now: Date };

type BucketRow = { key: string; tokens: number; rateFactor: number; updatedAt: Date };

function toState(row: BucketRow | undefined, fallback: () => BucketState): BucketState {
  return row ? { tokens: row.tokens, rateFactor: row.rateFactor, updatedAt: row.updatedAt } : fallback();
}

// ---------------------------------------------------------------------------
// Quota diária por utilizador
// ---------------------------------------------------------------------------

/**
 * Partes usadas hoje (dia civil de Lisboa) por quem paga: mensagens criadas por si (exceto
 * FAILED garantidamente não enviadas) + reservas em curso de campanhas que confirmou.
 * `db` pode ser a transação com o lock (autoritativo: as consultas separadas só são coerentes
 * porque nenhum SmsMessage é inserido enquanto o lock exclusivo está detido) ou o cliente
 * (informativo).
 */
export async function quotaUsage(db: Tx, payerId: string, now: Date): Promise<number> {
  const { start } = lisbonDayWindow(now);
  const notSent = { status: "FAILED" as const, errorCode: { in: [...NOT_SENT_ERROR_CODES] } };
  const [sum, withoutEstimate, reservations] = await Promise.all([
    db.smsMessage.aggregate({
      _sum: { segmentCountEstimate: true },
      where: { createdById: payerId, createdAt: { gte: start }, NOT: notSent },
    }),
    db.smsMessage.count({ where: { createdById: payerId, createdAt: { gte: start }, segmentCountEstimate: null, NOT: notSent } }),
    // Reservas recentes (no máximo SMS_SQS_MAX_IN_FLIGHT/lote por campanha: conjunto pequeno).
    // Sem limite no início do dia: uma reserva de antes da meia-noite cujo SmsMessage ainda não
    // existe vai ser criada hoje (createdAt de hoje) e tem de contar já para a quota de hoje.
    db.campaignRecipient.findMany({
      where: {
        status: "PROCESSING",
        claimedAt: { gte: new Date(now.getTime() - RESERVATION_TTL_MS) },
        campaign: { confirmedById: payerId },
      },
      select: { id: true, campaignId: true, attempt: true, segments: true },
    }),
  ]);
  // Uma reserva cujo SmsMessage desta tentativa já existe está contada acima: não contar duas
  // vezes (com a fila SQS o passo reserva enquanto o worker envia).
  const keys = reservations.map((r) => campaignIdempotencyKey(r.campaignId, r.id, r.attempt));
  const alreadyCreated = keys.length
    ? new Set(
        (await db.smsMessage.findMany({ where: { idempotencyKey: { in: keys } }, select: { idempotencyKey: true } })).map(
          (m) => m.idempotencyKey,
        ),
      )
    : new Set<string>();
  const reserved = reservations.reduce(
    (total, r, i) => total + (alreadyCreated.has(keys[i]) ? 0 : (r.segments ?? 0)),
    0,
  );
  return (sum._sum.segmentCountEstimate ?? 0) + withoutEstimate + reserved;
}

/** Verificação autoritativa do pagador (dentro da transação com o lock). */
async function checkPayer(tx: Tx, payerId: string, cost: number, limits: SendRateLimits, now: Date): Promise<PayerCheck> {
  const user = await tx.user.findUnique({ where: { id: payerId }, select: { isActive: true, dailyPartsLimit: true, role: true } });
  const { end } = lisbonDayWindow(now);
  const untilReset = Math.max(1_000, end.getTime() - now.getTime());
  if (!user) return { ok: false, limit: "user_blocked", retryAfterMs: untilReset, reason: "missing" };
  // Conta desativada ou sem permissão de envio (ex.: despromovida a VIEWER) nunca paga envios.
  if (!user.isActive || !can(user.role, "sms:send")) return { ok: false, limit: "user_blocked", retryAfterMs: untilReset, reason: "inactive" };
  const state = quotaState({
    limit: effectiveDailyLimit(user.dailyPartsLimit, limits.userDailyParts),
    used: await quotaUsage(tx, payerId, now),
    now,
  });
  if (!quotaAllows(state, cost)) return { ok: false, limit: "user_quota", retryAfterMs: untilReset, quota: state, cost };
  return { ok: true };
}

export type UserQuotaSnapshot = QuotaState & {
  active: boolean;
  /** Partes ainda por enviar (PENDING) em campanhas READY/SENDING confirmadas por este utilizador. */
  committedElsewhere: { parts: number; campaigns: Array<{ id: string; name: string; parts: number; paused: boolean }> };
};

/** Leitura informativa (sem lock) para UI, revisão §29 e retoma. null = utilizador inexistente. */
export async function getUserQuotaSnapshot(
  userId: string,
  defaultDailyParts: number,
  now = new Date(),
  options: { excludeCampaignId?: string } = {},
): Promise<UserQuotaSnapshot | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, dailyPartsLimit: true } });
  if (!user) return null;
  const [used, committed] = await Promise.all([
    quotaUsage(prisma, userId, now),
    prisma.campaignRecipient.groupBy({
      by: ["campaignId"],
      where: {
        status: "PENDING",
        campaign: {
          confirmedById: userId,
          status: { in: ["READY", "SENDING"] },
          ...(options.excludeCampaignId ? { id: { not: options.excludeCampaignId } } : {}),
        },
      },
      _sum: { segments: true },
    }),
  ]);
  const ids = committed.map((row) => row.campaignId);
  const campaigns = ids.length
    ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, pausedAt: true } })
    : [];
  const rows = committed.map((row) => {
    const campaign = campaigns.find((c) => c.id === row.campaignId);
    return { id: row.campaignId, name: campaign?.name ?? "—", parts: row._sum.segments ?? 0, paused: campaign?.pausedAt !== null };
  });
  return {
    ...quotaState({ limit: effectiveDailyLimit(user.dailyPartsLimit, defaultDailyParts), used, now }),
    active: user.isActive,
    committedElsewhere: { parts: rows.reduce((sum, row) => sum + row.parts, 0), campaigns: rows },
  };
}

// ---------------------------------------------------------------------------
// MPS (token buckets)
// ---------------------------------------------------------------------------

/**
 * Consome `segments` tokens de todos os baldes do destino, ou nenhum (tudo-ou-nada).
 * Tem de correr dentro da transação que detém o lock.
 */
async function consumeBuckets(tx: Tx, target: SendTarget, limits: SendRateLimits, now: Date): Promise<MpsCheck> {
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

// ---------------------------------------------------------------------------
// Reservas
// ---------------------------------------------------------------------------

/**
 * Reserva completa para um envio individual, numa transação que ainda não tem o lock (toma-o).
 * Ordem: global/minuto → pagador (ativo, quota) → MPS. Um bloqueio nunca grava nada.
 */
export async function reserveInTransaction(tx: Tx, target: SendTarget, payerId: string, limits: SendRateLimits, now: Date): Promise<RateCheck> {
  const { used, retryAfterMs } = await lockAndCount(tx, now);
  if (used >= limits.maxPerMinute) return { ok: false, retryAfterMs, limit: "per_minute" };
  const payer = await checkPayer(tx, payerId, Math.max(1, target.segments), limits, now);
  if (!payer.ok) return payer;
  return consumeBuckets(tx, target, limits, now);
}

/**
 * Reserva isolada (testes de MPS/limites). No envio individual real a reserva corre na mesma
 * transação que cria o SmsMessage (ver `createPendingMessage` do store), para que dois pedidos
 * simultâneos não passem ambos.
 */
export async function reserveSendCapacity(target: SendTarget, payerId: string, limits: SendRateLimits, now = new Date()): Promise<RateCheck> {
  return prisma.$transaction((tx) => reserveInTransaction(tx, target, payerId, limits, now));
}

/** THROTTLED da AWS: esvazia e abranda os baldes do destino (AIMD, ver token-bucket.ts). */
export async function recordProviderThrottle(
  target: Pick<SendTarget, "phoneE164">,
  limits: Pick<SendRateLimits, "rate" | "originKey">,
  now = new Date(),
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockSendRate(tx);
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
  | { kind: "rate_limited"; retryAfterMs: number; limit: "per_minute" | "campaign_per_minute" | "mps"; label?: string; perMinute?: number }
  /** A campanha não pode continuar (quota de quem confirmou esgotada ou conta desativada): pausar. */
  | { kind: "blocked"; code: typeof USER_QUOTA_HALT_CODE | typeof CONFIRMER_INACTIVE_HALT_CODE; message: string }
  | { kind: "none" };

/**
 * Reserva o próximo destinatário PENDING de uma campanha, sob o lock de rate limit:
 * a contagem, a quota de quem confirmou, o consumo de MPS e a reserva são atómicos em
 * relação a outros passos/campanhas/instâncias (o worker SQS só executa reservas já cobradas).
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

    const campaign = await tx.campaign.findUnique({
      where: { id: input.campaignId },
      select: { confirmedById: true, maxSendsPerMinute: true, confirmedBy: { select: { isActive: true, role: true } } },
    });
    if (!campaign) return { kind: "none" };

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

    // Ritmo próprio só depois de haver candidato: sem PENDING o passo não deve esperar um minuto.
    if (campaign.maxSendsPerMinute !== null) {
      const perMinute = effectivePerMinute(input.limits.maxPerMinute, campaign.maxSendsPerMinute);
      const own = await countCampaignMinute(tx, input.campaignId, input.now);
      if (own.used >= perMinute) return { kind: "rate_limited", retryAfterMs: own.retryAfterMs, limit: "campaign_per_minute", perMinute };
    }

    // Sem contacto/texto o envio não chega a acontecer (é ignorado/falhado): não consome nada.
    if (candidate.contact && candidate.segments !== null) {
      // Falha fechada: uma campanha sem confirmador válido nunca envia.
      if (!campaign.confirmedById || !campaign.confirmedBy?.isActive || !can(campaign.confirmedBy.role, "campaigns:send")) {
        return { kind: "blocked", code: CONFIRMER_INACTIVE_HALT_CODE, message: CONFIRMER_INACTIVE_HALT_MESSAGE };
      }
      const payer = await checkPayer(tx, campaign.confirmedById, candidate.segments, input.limits, input.now);
      if (!payer.ok) {
        return payer.limit === "user_quota"
          ? { kind: "blocked", code: USER_QUOTA_HALT_CODE, message: userQuotaHaltMessage(payer.quota) }
          : { kind: "blocked", code: CONFIRMER_INACTIVE_HALT_CODE, message: CONFIRMER_INACTIVE_HALT_MESSAGE };
      }
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
