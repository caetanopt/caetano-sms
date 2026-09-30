import { randomUUID } from "node:crypto";
import { isValidPhoneNumber } from "libphonenumber-js";
import { getCampaignLimits, type CampaignLimits } from "@/features/campaigns/limits";
import { getSendRateConfig, type SendRateConfig } from "@/features/rate-limit/rules";
import { getSmsJobQueueConfig, type SmsJobQueueConfig } from "@/lib/aws/sqs-config";
import { campaignIdempotencyKey, finalCampaignStatus, retryDelayMs, EMPTY_RECIPIENT_COUNTS } from "@/features/campaigns/processing-rules";
import { prisma } from "@/lib/db/prisma";
import { getSmsSegmentInfo } from "@/lib/sms/encoding";
import { consoleLogger, type Logger } from "@/lib/logging/logger";
import { getSmsProvider } from "@/lib/sms/provider";
import type { SmsErrorCode, SmsProvider } from "@/lib/sms/types";
import { prismaManualSendStore } from "@/server/repositories/prisma-manual-send-store";
import { claimNextRecipient, recordProviderThrottle, RESERVATION_TTL_MS, type SendRateLimits } from "../send-rate";
import { campaignPaceWaitReason } from "@/features/rate-limit/quota";
import { dispatchSms } from "../sms-dispatch";
import { currentOrigin, originMismatch, phoneHash, type CampaignOrigin } from "./origin";
import { SqsSmsJobQueue } from "./sqs-job-queue";

/**
 * Motor de campanhas (CLAUDE.md §17-§19).
 *
 * Garantias:
 * - nunca num pedido HTTP longo: cada passo processa no máximo `batchSize` mensagens;
 * - idempotência: chave `campaign:{campanha}:{destinatário}:{tentativa}` UNIQUE em SmsMessage;
 *   a tentativa só aumenta depois de uma falha garantidamente não enviada, pelo que uma
 *   recuperação ou um passo concorrente colidem na mesma chave e nunca reenviam;
 * - posse: cada destinatário é reservado (claimToken) imediatamente antes do envio e todas
 *   as transições são CAS sobre esse token;
 * - lease com dono por campanha, renovado antes de cada envio e libertado em finally;
 * - resultados incertos nunca são repetidos; erros de conta pausam a campanha.
 */

/**
 * Duração do lease; renovado antes de cada envio. Um envio AWS demora no máximo
 * AWS_SMS_CONNECTION_TIMEOUT_MS + AWS_SMS_REQUEST_TIMEOUT_MS (~13 s) + base de dados;
 * o fake no máximo 30 s. STALE_MS tem de ser bem maior do que isto.
 */
export const LEASE_MS = 60_000;
/** Um destinatário PROCESSING mais antigo do que isto é considerado abandonado (> lease). */
export const STALE_MS = RESERVATION_TTL_MS;
/** Resultados incertos seguidos que pausam a campanha. */
export const MAX_CONSECUTIVE_UNKNOWN = 3;
/** Uma confirmação nunca iniciada expira ao fim de 24 h (variáveis como data/hora podem estar obsoletas). */
export const CONFIRMATION_TTL_MS = 24 * 60 * 60_000;
/** Um passo deixa de reservar destinatários depois deste tempo (pedidos curtos). */
export const STEP_TIME_BUDGET_MS = 20_000;

/** Erros que afetam todos os destinatários: não consomem tentativas e pausam a campanha. */
const CAMPAIGN_LEVEL_ERRORS: ReadonlySet<SmsErrorCode> = new Set([
  "AUTH_ERROR",
  "CONFIGURATION_ERROR",
  "SPEND_LIMIT",
  "QUOTA_EXCEEDED",
]);

export type EngineDeps = {
  origin: () => CampaignOrigin;
  getProvider: () => SmsProvider;
  logger: Logger;
  limits: CampaignLimits;
  /** MPS por identidade de origem e país (CLAUDE.md §19). */
  rate: SendRateConfig;
  now: () => Date;
  random: () => number;
  /** Espera curta dentro de um passo quando o limite de MPS está quase livre. Omitido = devolve "wait". */
  sleep?: (ms: number) => Promise<void>;
  /** Fila de jobs. Omitida = DirectSmsJobQueue (envio dentro do passo). */
  queue?: SmsJobQueue;
};

const QUEUE_WAIT_MS = 1_000;
const QUEUE_ERROR_WAIT_MS = 5_000;

/** Destinatários reservados e ainda não terminados (exclui reservas abandonadas). */
function countInFlight(campaignId: string, now: Date) {
  return prisma.campaignRecipient.count({
    where: { campaignId, status: "PROCESSING", claimedAt: { gt: new Date(now.getTime() - STALE_MS) } },
  });
}

/** Esperas de MPS até este valor são feitas dentro do passo (evita um pedido por mensagem). */
export const IN_STEP_WAIT_MAX_MS = 2_000;

function sendRateLimits(deps: Pick<EngineDeps, "limits" | "rate" | "origin">): SendRateLimits {
  return {
    maxPerMinute: deps.limits.maxSendsPerMinute,
    rate: deps.rate,
    originKey: deps.origin().originationHash,
    userDailyParts: deps.limits.userDailyParts,
  };
}

export function defaultEngineDeps(): EngineDeps {
  return {
    origin: () => currentOrigin(),
    getProvider: () => getSmsProvider(),
    logger: consoleLogger,
    limits: getCampaignLimits(),
    rate: getSendRateConfig(),
    now: () => new Date(),
    random: Math.random,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    queue: jobQueueFromConfig(getSmsJobQueueConfig()),
  };
}

/** `SMS_JOB_QUEUE=direct` → envio dentro do passo; `sqs` → publicação no SQS. */
export function jobQueueFromConfig(config: SmsJobQueueConfig): SmsJobQueue | undefined {
  return config.kind === "sqs" ? new SqsSmsJobQueue(config) : undefined;
}

export const idempotencyKeyFor = campaignIdempotencyKey;

// ---------------------------------------------------------------------------
// Fila (CLAUDE.md §17): o domínio depende só da interface.
// ---------------------------------------------------------------------------

export type SendSmsJob = { campaignId: string; recipientId: string; claimToken: string };

export interface SmsJobQueue {
  enqueue(job: SendSmsJob): Promise<void>;
  /**
   * Filas assíncronas: máximo de destinatários em PROCESSING por campanha. O passo não
   * reserva mais enquanto houver este número em curso (limita a rajada dos consumidores,
   * já que o rate limit é aplicado na reserva). Omitido = fila síncrona.
   */
  readonly maxInFlight?: number;
}

/**
 * Implementação para o MVP: executa o job de imediato, dentro do passo (limitado a
 * `batchSize`). Com `SqsSmsJobQueue` o passo publica o job e `pnpm worker:sms-jobs` chama
 * `sendCampaignRecipient` — os efeitos ao nível da campanha (pausa, backoff) são escritos
 * na base de dados pelo próprio job, pelo que o passo não depende do resultado.
 */
export class DirectSmsJobQueue implements SmsJobQueue {
  constructor(private readonly deps: EngineDeps) {}
  async enqueue(job: SendSmsJob) {
    await sendCampaignRecipient(job, this.deps);
  }
}

// ---------------------------------------------------------------------------
// Envio de um destinatário
// ---------------------------------------------------------------------------

type RecipientPatch = Parameters<typeof prisma.campaignRecipient.updateMany>[0]["data"];

async function updateOwned(job: SendSmsJob, data: RecipientPatch) {
  const { count } = await prisma.campaignRecipient.updateMany({
    where: { id: job.recipientId, status: "PROCESSING", claimToken: job.claimToken },
    data,
  });
  return count === 1;
}

/**
 * Devolve o destinatário à fila — exceto se a campanha foi cancelada entretanto
 * (um envio em curso durante o cancelamento nunca volta a PENDING).
 */
async function requeue(job: SendSmsJob, data: RecipientPatch) {
  const campaign = await prisma.campaign.findUnique({ where: { id: job.campaignId }, select: { status: true } });
  if (campaign?.status === "CANCELLED") {
    return updateOwned(job, {
      status: "CANCELLED",
      claimToken: null,
      renderedBody: null,
      messageId: data.messageId,
      errorCode: data.errorCode,
      errorMessage: data.errorMessage,
    });
  }
  return updateOwned(job, data);
}

/** Estado terminal: apaga o texto congelado (o SmsMessage guarda o que foi enviado). */
const terminal = (status: "ACCEPTED" | "FAILED" | "UNKNOWN" | "SKIPPED" | "CANCELLED") => ({
  status,
  claimToken: null,
  renderedBody: null,
});

async function haltCampaign(campaignId: string, reason: string, deps: Pick<EngineDeps, "now" | "logger">, code: string) {
  const { count } = await prisma.campaign.updateMany({
    where: { id: campaignId, status: { in: ["READY", "SENDING"] }, pausedAt: null },
    data: { pausedAt: deps.now(), pausedById: null, lastError: reason },
  });
  if (count === 1) {
    await prisma.auditLog.create({
      data: { action: "CAMPAIGN_HALTED", entityType: "Campaign", entityId: campaignId, metadataJson: { reason: code } },
    });
    deps.logger.log("error", "campaign.halted", { campaignId, errorCode: code });
  }
}

const HALT_MESSAGES: Partial<Record<SmsErrorCode, string>> = {
  AUTH_ERROR: "Envio parado: falha de autenticação/autorização com a AWS.",
  CONFIGURATION_ERROR: "Envio parado: configuração AWS inválida (origem, Configuration Set ou país).",
  SPEND_LIMIT: "Envio parado: limite de gastos de SMS da conta AWS atingido.",
  QUOTA_EXCEEDED: "Envio parado: quota da conta AWS atingida.",
};

/**
 * Envia um destinatário reservado. Re-verifica consentimento/opt-out imediatamente antes
 * do envio (CLAUDE.md §12) e aplica os efeitos ao nível da campanha.
 */
export async function sendCampaignRecipient(job: SendSmsJob, deps: EngineDeps): Promise<void> {
  const recipient = await prisma.campaignRecipient.findUnique({
    where: { id: job.recipientId },
    include: {
      contact: { select: { id: true, phoneE164: true, consentStatus: true, optedOutAt: true } },
      campaign: {
        select: {
          id: true,
          status: true,
          pausedAt: true,
          messageType: true,
          templateId: true,
          confirmedById: true,
          createdById: true,
          mode: true,
          provider: true,
          originationHash: true,
          nextStepAt: true,
        },
      },
    },
  });
  if (!recipient || recipient.status !== "PROCESSING" || recipient.claimToken !== job.claimToken) return;
  const { campaign, contact } = recipient;

  if (campaign.status === "CANCELLED") {
    await updateOwned(job, terminal("CANCELLED"));
    return;
  }
  // Pausa ou backoff de throttling ao nível da campanha: um job já publicado (SQS) espera.
  if (campaign.pausedAt || campaign.status !== "SENDING" || (campaign.nextStepAt && campaign.nextStepAt > deps.now())) {
    await requeue(job, { status: "PENDING", claimToken: null });
    return;
  }
  // O job pode correr noutro processo (worker SQS) com outra configuração: um envio
  // confirmado em TESTE nunca pode sair por um processo em PRODUÇÃO (e vice-versa).
  const mismatch = originMismatch(campaign, deps.origin());
  if (mismatch) {
    await requeue(job, { status: "PENDING", claimToken: null });
    await haltCampaign(campaign.id, mismatch, deps, "ORIGIN_CHANGED");
    return;
  }
  if (!contact) {
    await updateOwned(job, { ...terminal("SKIPPED"), skipReason: "CONTACT_DELETED" });
    return;
  }

  // Re-verificação imediatamente antes do envio.
  const suppressed =
    (await prisma.suppressionEntry.findUnique({ where: { phoneE164: contact.phoneE164 }, select: { id: true } })) !==
    null;
  const skipReason = !isValidPhoneNumber(contact.phoneE164)
    ? "INVALID_PHONE"
    : suppressed || contact.optedOutAt !== null || contact.consentStatus === "OPTED_OUT"
      ? "OPTED_OUT"
      : contact.consentStatus !== "OPTED_IN"
        ? "NO_CONSENT"
        : null;
  if (skipReason) {
    await updateOwned(job, { ...terminal("SKIPPED"), skipReason });
    deps.logger.log("info", "campaign.recipient.skipped", { campaignId: campaign.id, errorCode: skipReason });
    return;
  }
  // O número tem de ser o que foi revisto na confirmação.
  if (recipient.phoneHash && recipient.phoneHash !== phoneHash(contact.phoneE164)) {
    await updateOwned(job, { ...terminal("SKIPPED"), skipReason: "PHONE_CHANGED" });
    return;
  }
  if (!recipient.renderedBody || recipient.segments === null) {
    await updateOwned(job, { ...terminal("FAILED"), errorCode: "VALIDATION_ERROR", errorMessage: "Texto em falta." });
    return;
  }

  // Reafirma a posse imediatamente antes de chamar o provider.
  if (!(await updateOwned(job, { claimedAt: deps.now() }))) return;

  let provider: SmsProvider;
  try {
    provider = deps.getProvider();
  } catch {
    await requeue(job, { status: "PENDING", claimToken: null });
    await haltCampaign(campaign.id, "Envio parado: o serviço de envio não está configurado corretamente.", deps, "CONFIGURATION_ERROR");
    return;
  }

  const idempotencyKey = idempotencyKeyFor(campaign.id, recipient.id, recipient.attempt);
  const origin = deps.origin();
  let outcome;
  try {
    outcome = await dispatchSms(
      {
        message: {
          idempotencyKey,
          contactId: contact.id,
          destinationPhoneE164: contact.phoneE164,
          messageType: campaign.messageType,
          body: recipient.renderedBody,
          encodingEstimate: getSmsSegmentInfo(recipient.renderedBody).encoding,
          segmentCountEstimate: recipient.segments,
          templateId: campaign.templateId,
          campaignId: campaign.id,
          createdById: campaign.confirmedById ?? campaign.createdById,
        },
        source: "campaign",
        context: { campaignId: campaign.id },
        auditMetadata: null,
        logFields: { campaignId: campaign.id },
      },
      {
        store: prismaManualSendStore,
        config: origin.config,
        provider,
        logger: deps.logger,
        now: deps.now,
        onThrottled: (phoneE164) => recordProviderThrottle({ phoneE164 }, sendRateLimits(deps), deps.now()),
      },
    );
  } catch {
    // Exceção fora do provider (ex.: base de dados). Decide pela existência do registo.
    const existing = await prisma.smsMessage.findUnique({ where: { idempotencyKey }, select: { id: true, status: true } });
    if (!existing) {
      await requeue(job, { status: "PENDING", claimToken: null });
    } else if (existing.status === "PENDING") {
      // Pode ter sido enviado: fica incerto, nunca é repetido.
      await prisma.smsMessage.updateMany({
        where: { id: existing.id, status: "PENDING" },
        data: { status: "UNKNOWN", errorCode: "UNKNOWN", errorMessage: "Erro interno após o pedido ao fornecedor." },
      });
      await updateOwned(job, { ...terminal("UNKNOWN"), messageId: existing.id, errorCode: "UNKNOWN" });
    }
    return;
  }

  const now = deps.now();
  switch (outcome.kind) {
    case "duplicate": {
      // Outro envio já usou esta chave: nunca reenviar; sincronizar se já terminou.
      const status = outcome.status;
      if (status === "ACCEPTED" || status === "FAILED" || status === "UNKNOWN") {
        await updateOwned(job, { ...terminal(status), messageId: outcome.messageId });
      }
      return;
    }
    case "rate_limited":
      // Só ocorre com reserva no store; campanhas reservam no claim. Devolver à fila por segurança.
      await requeue(job, { status: "PENDING", claimToken: null });
      return;
    case "accepted":
      await updateOwned(job, { ...terminal("ACCEPTED"), messageId: outcome.messageId, errorCode: null, errorMessage: null });
      await prisma.campaign.update({ where: { id: campaign.id }, data: { consecutiveUnknown: 0 } });
      return;
    case "uncertain": {
      await updateOwned(job, {
        ...terminal("UNKNOWN"),
        messageId: outcome.messageId,
        errorCode: outcome.errorCode,
        errorMessage: outcome.message,
      });
      const updated = await prisma.campaign.update({
        where: { id: campaign.id },
        data: { consecutiveUnknown: { increment: 1 } },
        select: { consecutiveUnknown: true },
      });
      if (updated.consecutiveUnknown >= MAX_CONSECUTIVE_UNKNOWN) {
        await haltCampaign(
          campaign.id,
          `Envio parado: ${MAX_CONSECUTIVE_UNKNOWN} resultados incertos seguidos. Verifica o estado na AWS antes de retomar.`,
          deps,
          "CONSECUTIVE_UNKNOWN",
        );
      }
      return;
    }
    case "failed": {
      if (CAMPAIGN_LEVEL_ERRORS.has(outcome.errorCode)) {
        // 4xx ao nível da conta: nada foi enviado. Nova tentativa (nova chave) sem gastar retries.
        await requeue(job, {
          status: "PENDING",
          claimToken: null,
          attempt: { increment: 1 },
          messageId: outcome.messageId,
          errorCode: outcome.errorCode,
          errorMessage: outcome.message,
        });
        await haltCampaign(campaign.id, HALT_MESSAGES[outcome.errorCode] ?? outcome.message, deps, outcome.errorCode);
        return;
      }
      // Só é repetido o que o adapter marcou como seguro (garantidamente não enviado).
      if (outcome.retryable && recipient.retries + 1 >= deps.limits.maxAttempts) {
        // Throttling/indisponibilidade prolongados: pausar em vez de falhar destinatários em massa.
        await requeue(job, {
          status: "PENDING",
          claimToken: null,
          attempt: { increment: 1 },
          messageId: outcome.messageId,
          errorCode: outcome.errorCode,
          errorMessage: outcome.message,
        });
        await haltCampaign(
          campaign.id,
          "Envio parado: a AWS continua a limitar ou indisponível após várias tentativas. Retoma mais tarde.",
          deps,
          "RETRIES_EXHAUSTED",
        );
        return;
      }
      if (outcome.retryable) {
        const delay = retryDelayMs(recipient.retries + 1, deps.random);
        await requeue(job, {
          status: "PENDING",
          claimToken: null,
          attempt: { increment: 1 },
          retries: { increment: 1 },
          nextAttemptAt: new Date(now.getTime() + delay),
          messageId: outcome.messageId,
          errorCode: outcome.errorCode,
          errorMessage: outcome.message,
        });
        // Throttling/indisponibilidade afetam a conta: abrandar toda a campanha (§19).
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { nextStepAt: new Date(now.getTime() + delay) },
        });
        return;
      }
      await updateOwned(job, {
        ...terminal("FAILED"),
        messageId: outcome.messageId,
        errorCode: outcome.errorCode,
        errorMessage: outcome.message,
      });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Reconciliação (corre em todos os passos, antes das verificações de estado)
// ---------------------------------------------------------------------------

export async function reconcileStaleRecipients(campaignId: string, deps: Pick<EngineDeps, "now" | "logger">) {
  const threshold = new Date(deps.now().getTime() - STALE_MS);
  const stale = await prisma.campaignRecipient.findMany({
    where: { campaignId, status: "PROCESSING", claimedAt: { lt: threshold } },
    select: { id: true, claimToken: true, attempt: true },
    take: 100,
  });
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });

  for (const row of stale) {
    // claimedAt no filtro: um job que reafirmou a posse entretanto não é tocado.
    const where = { id: row.id, status: "PROCESSING" as const, claimToken: row.claimToken, claimedAt: { lt: threshold } };
    const message = await prisma.smsMessage.findUnique({
      where: { idempotencyKey: idempotencyKeyFor(campaignId, row.id, row.attempt) },
      select: { id: true, status: true, createdAt: true, errorCode: true },
    });

    if (!message) {
      // O provider nunca foi chamado para esta tentativa: seguro voltar a PENDING (mesma chave).
      await prisma.campaignRecipient.updateMany({
        where,
        data: campaign?.status === "CANCELLED" ? { status: "CANCELLED", claimToken: null, renderedBody: null } : { status: "PENDING", claimToken: null },
      });
      continue;
    }
    if (message.status === "PENDING") {
      if (message.createdAt >= threshold) continue; // ainda em curso
      await prisma.smsMessage.updateMany({
        where: { id: message.id, status: "PENDING" },
        data: {
          status: "UNKNOWN",
          errorCode: "UNKNOWN",
          errorMessage: "Sem resposta do processo de envio: resultado incerto (não reenviar sem verificar).",
        },
      });
      await prisma.campaignRecipient.updateMany({
        where,
        data: { status: "UNKNOWN", claimToken: null, renderedBody: null, messageId: message.id, errorCode: "UNKNOWN" },
      });
      deps.logger.log("warn", "campaign.recipient.recovered_unknown", { campaignId, messageInternalId: message.id });
      continue;
    }
    // FAILED garantidamente não enviado por causa retryable/de conta: tratar como no caminho normal.
    if (message.status === "FAILED" && message.errorCode && campaign?.status !== "CANCELLED") {
      const code = message.errorCode as SmsErrorCode;
      if (CAMPAIGN_LEVEL_ERRORS.has(code) || code === "THROTTLED" || code === "PROVIDER_UNAVAILABLE") {
        await prisma.campaignRecipient.updateMany({
          where,
          data: { status: "PENDING", claimToken: null, attempt: { increment: 1 }, messageId: message.id, errorCode: code },
        });
        if (CAMPAIGN_LEVEL_ERRORS.has(code)) {
          await haltCampaign(campaignId, HALT_MESSAGES[code] ?? "Envio parado: erro da conta AWS.", deps, code);
        }
        continue;
      }
    }
    const final = message.status === "ACCEPTED" ? "ACCEPTED" : message.status === "FAILED" ? "FAILED" : "UNKNOWN";
    await prisma.campaignRecipient.updateMany({
      where,
      data: { status: final, claimToken: null, renderedBody: null, messageId: message.id, errorCode: message.errorCode },
    });
  }
}

// ---------------------------------------------------------------------------
// Progresso e finalização
// ---------------------------------------------------------------------------

export async function recipientCounts(campaignId: string) {
  const groups = await prisma.campaignRecipient.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const counts = { ...EMPTY_RECIPIENT_COUNTS };
  for (const group of groups) counts[group.status] = group._count._all;
  return counts;
}

export async function finalizeIfDone(campaignId: string, deps: Pick<EngineDeps, "now" | "logger">) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true, finishedAt: true } });
  if (!campaign) return;
  const counts = await recipientCounts(campaignId);

  if (campaign.status === "CANCELLED") {
    if (counts.PENDING > 0) {
      await prisma.campaignRecipient.updateMany({
        where: { campaignId, status: "PENDING" },
        data: { status: "CANCELLED", claimToken: null, renderedBody: null },
      });
    }
    if (!campaign.finishedAt && counts.PROCESSING === 0) {
      await prisma.campaign.updateMany({ where: { id: campaignId, finishedAt: null }, data: { finishedAt: deps.now() } });
    }
    return;
  }
  if (campaign.status !== "SENDING") return;

  const final = finalCampaignStatus(counts);
  if (!final) return;
  const nothingSent = counts.ACCEPTED === 0 && counts.FAILED === 0 && counts.UNKNOWN === 0;
  const { count } = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "SENDING" },
    data: {
      status: final,
      finishedAt: deps.now(),
      processingLeaseToken: null,
      processingLeaseUntil: null,
      lastError: nothingSent ? "Nenhum destinatário continuava elegível no momento do envio." : undefined,
    },
  });
  if (count === 1) {
    await prisma.auditLog.create({
      data: {
        action: "CAMPAIGN_FINISHED",
        entityType: "Campaign",
        entityId: campaignId,
        metadataJson: { status: final, ...counts },
      },
    });
    deps.logger.log("info", "campaign.finished", { campaignId, status: final });
  }
}

/** Só reconciliação (nunca envia): usado em campanhas canceladas com envios presos. */
export async function reconcileCampaign(campaignId: string, deps: Pick<EngineDeps, "now" | "logger">) {
  await reconcileStaleRecipients(campaignId, deps);
  await finalizeIfDone(campaignId, deps);
}

/**
 * Uma confirmação nunca iniciada expira: a campanha volta a rascunho e o texto congelado
 * (com nomes) é apagado. Só se nenhum SMS foi tentado.
 */
async function expireConfirmation(campaignId: string, deps: Pick<EngineDeps, "now">) {
  const expiredBefore = new Date(deps.now().getTime() - CONFIRMATION_TTL_MS);
  return prisma.$transaction(async (tx) => {
    if ((await tx.smsMessage.count({ where: { campaignId } })) > 0) return false;
    const { count } = await tx.campaign.updateMany({
      where: { id: campaignId, status: "READY", startedAt: null, confirmedAt: { lt: expiredBefore } },
      data: {
        status: "DRAFT",
        mode: null,
        provider: null,
        originationHash: null,
        confirmedAt: null,
        confirmedById: null,
        pausedAt: null,
        pausedById: null,
        lastError: null,
      },
    });
    if (count === 0) return false;
    await tx.campaignRecipient.deleteMany({ where: { campaignId } });
    await tx.auditLog.create({
      data: { action: "CAMPAIGN_CONFIRMATION_EXPIRED", entityType: "Campaign", entityId: campaignId, metadataJson: {} },
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// Passo de processamento
// ---------------------------------------------------------------------------

export type StepResult =
  | { state: "done"; status: string }
  | { state: "paused"; reason: string | null }
  | { state: "busy"; waitMs: number }
  | { state: "wait"; waitMs: number; reason: string }
  | { state: "continue"; sent: number };

export async function processCampaignStep(campaignId: string, deps: EngineDeps): Promise<StepResult> {
  await reconcileStaleRecipients(campaignId, deps);
  await finalizeIfDone(campaignId, deps);

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return { state: "done", status: "NOT_FOUND" };
  if (!["READY", "SENDING"].includes(campaign.status)) return { state: "done", status: campaign.status };
  if (campaign.pausedAt) return { state: "paused", reason: campaign.lastError };

  const now = deps.now();
  if (campaign.status === "READY" && !campaign.startedAt && campaign.confirmedAt &&
      now.getTime() - campaign.confirmedAt.getTime() > CONFIRMATION_TTL_MS) {
    await expireConfirmation(campaignId, deps);
    return { state: "done", status: "DRAFT" };
  }

  const mismatch = originMismatch(campaign, deps.origin());
  if (mismatch) {
    await haltCampaign(campaignId, mismatch, deps, "ORIGIN_CHANGED");
    return { state: "paused", reason: mismatch };
  }

  if (campaign.nextStepAt && campaign.nextStepAt > now) {
    return { state: "wait", waitMs: campaign.nextStepAt.getTime() - now.getTime(), reason: "Backoff após throttling." };
  }

  // Lease com dono.
  const leaseToken = randomUUID();
  const acquired = await prisma.campaign.updateMany({
    where: {
      id: campaignId,
      status: { in: ["READY", "SENDING"] },
      pausedAt: null,
      OR: [{ processingLeaseUntil: null }, { processingLeaseUntil: { lt: now } }],
    },
    data: { processingLeaseToken: leaseToken, processingLeaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (acquired.count === 0) return { state: "busy", waitMs: 2_000 };

  let sent = 0;
  let result: StepResult | null = null;
  try {
    if (campaign.status === "READY") {
      await prisma.campaign.updateMany({
        where: { id: campaignId, status: "READY" },
        data: { status: "SENDING", startedAt: now },
      });
    }
    const queue: SmsJobQueue = deps.queue ?? new DirectSmsJobQueue(deps);

    const stepStartedAt = deps.now().getTime();
    while (sent < deps.limits.batchSize && deps.now().getTime() - stepStartedAt < STEP_TIME_BUDGET_MS) {
      // Fencing: renovar o lease; se o perdemos, a campanha foi pausada/cancelada ou está em backoff, parar.
      const at = deps.now();
      const renewed = await prisma.campaign.updateMany({
        where: {
          id: campaignId,
          processingLeaseToken: leaseToken,
          status: "SENDING",
          pausedAt: null,
          OR: [{ nextStepAt: null }, { nextStepAt: { lte: at } }],
        },
        data: { processingLeaseUntil: new Date(at.getTime() + LEASE_MS) },
      });
      if (renewed.count === 0) break;

      if (queue.maxInFlight !== undefined) {
        const inFlight = await countInFlight(campaignId, at);
        if (inFlight >= queue.maxInFlight) {
          result = { state: "wait", waitMs: QUEUE_WAIT_MS, reason: "A aguardar a fila de envio." };
          break;
        }
      }

      const claim = await claimNextRecipient({ campaignId, claimToken: randomUUID(), limits: sendRateLimits(deps), now: at });
      if (claim.kind === "blocked") {
        // Quota de quem confirmou esgotada ou conta desativada: pausa persistida, retoma manual.
        await haltCampaign(campaignId, claim.message, deps, claim.code);
        result = { state: "paused", reason: claim.message };
        break;
      }
      if (claim.kind === "rate_limited") {
        const budgetLeft = STEP_TIME_BUDGET_MS - (deps.now().getTime() - stepStartedAt);
        if (claim.limit === "mps" && deps.sleep && claim.retryAfterMs <= Math.min(IN_STEP_WAIT_MAX_MS, budgetLeft)) {
          await deps.sleep(claim.retryAfterMs);
          continue;
        }
        result = {
          state: "wait",
          waitMs: claim.retryAfterMs,
          reason:
            claim.limit === "per_minute"
              ? "Limite interno de envios por minuto."
              : claim.limit === "campaign_per_minute"
                ? campaignPaceWaitReason(claim.perMinute ?? 0)
                : `Limite de partes SMS por segundo (${claim.label ?? "origem"}).`,
        };
        break;
      }
      if (claim.kind === "none") {
        const next = await prisma.campaignRecipient.findFirst({
          where: { campaignId, status: "PENDING", nextAttemptAt: { gt: at } },
          orderBy: { nextAttemptAt: "asc" },
          select: { nextAttemptAt: true },
        });
        if (next?.nextAttemptAt) {
          result = { state: "wait", waitMs: next.nextAttemptAt.getTime() - at.getTime(), reason: "A aguardar nova tentativa." };
        } else if (queue.maxInFlight !== undefined && (await countInFlight(campaignId, at)) > 0) {
          result = { state: "wait", waitMs: QUEUE_WAIT_MS, reason: "A aguardar a fila de envio." };
        }
        break;
      }

      const job = { campaignId, recipientId: claim.recipient.id, claimToken: claim.recipient.claimToken };
      try {
        await queue.enqueue(job);
      } catch (error) {
        // Publicação falhada: nada foi enviado. Libertar a reserva (mesma tentativa) e esperar.
        await prisma.campaignRecipient.updateMany({
          where: { id: job.recipientId, status: "PROCESSING", claimToken: job.claimToken },
          data: { status: "PENDING", claimToken: null },
        });
        deps.logger.log("error", "campaign.queue.enqueue_failed", {
          campaignId,
          errorCode: error instanceof Error ? error.name : "Error",
        });
        result = { state: "wait", waitMs: QUEUE_ERROR_WAIT_MS, reason: "Fila de envio indisponível; nova tentativa em breve." };
        break;
      }
      sent += 1;
    }
  } finally {
    await prisma.campaign.updateMany({
      where: { id: campaignId, processingLeaseToken: leaseToken },
      data: { processingLeaseToken: null, processingLeaseUntil: null },
    });
  }

  await finalizeIfDone(campaignId, deps);
  const after = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, pausedAt: true, lastError: true, nextStepAt: true },
  });
  if (!after || !["READY", "SENDING"].includes(after.status)) return { state: "done", status: after?.status ?? "NOT_FOUND" };
  if (after.pausedAt) return { state: "paused", reason: after.lastError };
  if (after.nextStepAt && after.nextStepAt > deps.now()) {
    return { state: "wait", waitMs: after.nextStepAt.getTime() - deps.now().getTime(), reason: "Backoff após throttling." };
  }
  return result ?? { state: "continue", sent };
}
