import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";

/**
 * Rate limit global de envios (CLAUDE.md §19): SMS_MAX_SENDS_PER_MINUTE para
 * campanhas e envio individual em conjunto.
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

export type RateCheck = { ok: true } | { ok: false; retryAfterMs: number };

/** Verificação para o envio individual (ritmo humano: sobreposição residual aceitável). */
export async function checkSendRate(maxPerMinute: number, now = new Date()): Promise<RateCheck> {
  return prisma.$transaction(async (tx) => {
    const { used, retryAfterMs } = await lockAndCount(tx, now);
    return used >= maxPerMinute ? { ok: false, retryAfterMs } : { ok: true };
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
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "none" };

/**
 * Reserva o próximo destinatário PENDING de uma campanha, sob o lock de rate limit:
 * a contagem e a reserva são atómicas em relação a outros passos/campanhas.
 */
export async function claimNextRecipient(input: {
  campaignId: string;
  claimToken: string;
  maxPerMinute: number;
  now: Date;
}): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    const { used, retryAfterMs } = await lockAndCount(tx, input.now);
    if (used >= input.maxPerMinute) return { kind: "rate_limited", retryAfterMs };

    const candidate = await tx.campaignRecipient.findFirst({
      where: {
        campaignId: input.campaignId,
        status: "PENDING",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: input.now } }],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!candidate) return { kind: "none" };

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
