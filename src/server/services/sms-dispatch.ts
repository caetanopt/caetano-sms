import type { LogFields, Logger } from "@/lib/logging/logger";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import type { SmsRuntimeConfig } from "@/lib/sms/config";
import type { SmsSegmentInfo } from "@/lib/sms/encoding";
import type { SmsErrorCode, SmsMessageType, SmsProvider, SmsSendResult } from "@/lib/sms/types";

/**
 * Núcleo comum de envio (envio individual e campanhas): cria o SmsMessage PENDING
 * com a chave de idempotência, chama o provider e regista o resultado.
 * As validações de negócio (consentimento, opt-out, template) são feitas antes,
 * por quem chama.
 */

export type AuditEntry = {
  userId: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata: Record<string, string | number | boolean | null>;
};

export type PendingMessageData = {
  idempotencyKey: string;
  contactId: string | null;
  destinationPhoneE164: string;
  messageType: SmsMessageType;
  body: string;
  encodingEstimate: SmsSegmentInfo["encoding"];
  segmentCountEstimate: number;
  provider: string;
  dryRun: boolean;
  templateId: string | null;
  campaignId: string | null;
  createdById: string;
};

export type MessageOutcomeUpdate =
  | { status: "ACCEPTED"; awsMessageId: string; provider: string; sentAt: Date }
  | {
      status: "FAILED" | "UNKNOWN";
      errorCode: SmsErrorCode;
      errorMessage: string;
      providerErrorName?: string;
      providerRequestId?: string;
      failedAt: Date | null;
    };

export interface DispatchStore {
  findMessageByIdempotencyKey(key: string): Promise<{ id: string; status: string } | null>;
  /** Devolve null se já existir uma mensagem com a mesma chave de idempotência. */
  createPendingMessage(data: PendingMessageData): Promise<{ id: string } | null>;
  /** `audit` null: não regista auditoria por mensagem (campanhas auditam ao nível da campanha). */
  completeMessage(id: string, update: MessageOutcomeUpdate, audit: AuditEntry | null): Promise<void>;
  /** Adiciona o número à suppression list e marca o contacto (se existir) em opt-out. */
  recordProviderOptOut(phoneE164: string, contactId: string | null, audit: AuditEntry): Promise<void>;
}

export type DispatchDeps = {
  store: DispatchStore;
  config: SmsRuntimeConfig;
  provider: SmsProvider;
  logger: Logger;
  now: () => Date;
};

export type DispatchInput = {
  message: Omit<PendingMessageData, "provider" | "dryRun">;
  source: "manual" | "campaign";
  /** Metadados não sensíveis enviados à AWS (Context). */
  context?: Record<string, string>;
  /** Metadados extra da auditoria por mensagem; null desativa a auditoria por mensagem. */
  auditMetadata: AuditEntry["metadata"] | null;
  logFields?: Pick<LogFields, "campaignId">;
};

export type DispatchOutcome =
  | { kind: "duplicate"; messageId: string; status: string }
  | { kind: "accepted"; messageId: string; providerMessageId: string }
  | { kind: "failed"; messageId: string; errorCode: SmsErrorCode; message: string; retryable: boolean }
  | { kind: "uncertain"; messageId: string; errorCode: SmsErrorCode; message: string };

export async function dispatchSms(input: DispatchInput, deps: DispatchDeps): Promise<DispatchOutcome> {
  const { store, config, provider, logger, now } = deps;
  const { message } = input;
  const dryRun = config.mode === "TEST";
  const maskedDestination = maskPhoneNumber(message.destinationPhoneE164);

  const created = await store.createPendingMessage({ ...message, provider: config.provider, dryRun });
  if (!created) {
    const existing = await store.findMessageByIdempotencyKey(message.idempotencyKey);
    logger.log("info", "sms.send.duplicate", {
      ...input.logFields,
      messageInternalId: existing?.id,
      userId: message.createdById,
      status: existing?.status,
    });
    return { kind: "duplicate", messageId: existing?.id ?? "", status: existing?.status ?? "PENDING" };
  }

  const baseLog: LogFields = {
    ...input.logFields,
    messageInternalId: created.id,
    userId: message.createdById,
    provider: config.provider,
    dryRun,
    maskedDestination,
    segments: message.segmentCountEstimate,
  };

  const startedAt = performance.now();
  let result: SmsSendResult;
  try {
    result = await provider.send({
      destinationPhoneNumber: message.destinationPhoneE164,
      messageBody: message.body,
      messageType: message.messageType,
      dryRun: config.dryRun,
      context: { ...input.context, internalMessageId: created.id, source: input.source },
    });
  } catch (error) {
    // Erro inesperado no adapter: não sabemos se o pedido chegou ao fornecedor.
    result = {
      ok: false,
      errorCode: "UNKNOWN",
      errorMessage: "Erro inesperado no envio. O resultado é incerto; não reenviar sem verificar.",
      retryable: false,
      uncertain: true,
      providerErrorName: error instanceof Error ? error.name : "UnknownError",
    };
  }
  const durationMs = Math.round(performance.now() - startedAt);
  const audit = (action: string, metadata: AuditEntry["metadata"]): AuditEntry | null =>
    input.auditMetadata === null
      ? null
      : {
          userId: message.createdById,
          action,
          entityType: "SmsMessage",
          entityId: created.id,
          metadata: { destination: maskedDestination, ...metadata },
        };

  if (result.ok) {
    await store.completeMessage(
      created.id,
      { status: "ACCEPTED", awsMessageId: result.messageId, provider: result.provider, sentAt: now() },
      audit("SMS_SEND_ACCEPTED", {
        provider: result.provider,
        messageType: message.messageType,
        segments: message.segmentCountEstimate,
        dryRun,
        ...input.auditMetadata,
      }),
    );
    logger.log("info", "sms.send.accepted", {
      ...baseLog,
      awsMessageId: result.messageId,
      status: "ACCEPTED",
      durationMs,
    });
    return { kind: "accepted", messageId: created.id, providerMessageId: result.messageId };
  }

  const status = result.uncertain ? "UNKNOWN" : "FAILED";
  await store.completeMessage(
    created.id,
    {
      status,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      providerErrorName: result.providerErrorName,
      providerRequestId: result.providerRequestId,
      failedAt: result.uncertain ? null : now(),
    },
    audit(result.uncertain ? "SMS_SEND_UNCERTAIN" : "SMS_SEND_FAILED", {
      errorCode: result.errorCode,
      providerErrorName: result.providerErrorName ?? null,
      retryable: result.retryable,
      uncertain: result.uncertain,
    }),
  );

  if (result.errorCode === "OPTED_OUT") {
    // Suppression list local: refletir o opt-out comunicado pelo fornecedor (sempre auditado).
    await store.recordProviderOptOut(message.destinationPhoneE164, message.contactId, {
      userId: message.createdById,
      action: "CONTACT_OPTED_OUT_BY_PROVIDER",
      entityType: message.contactId ? "Contact" : "SuppressionEntry",
      entityId: message.contactId ?? undefined,
      metadata: { messageId: created.id, provider: config.provider, destination: maskedDestination },
    });
  }

  logger.log(result.uncertain ? "error" : "warn", result.uncertain ? "sms.send.uncertain" : "sms.send.failed", {
    ...baseLog,
    status,
    durationMs,
    errorCode: result.errorCode,
    providerErrorName: result.providerErrorName,
    providerRequestId: result.providerRequestId,
    retryable: result.retryable,
    uncertain: result.uncertain,
  });

  if (result.uncertain) {
    return { kind: "uncertain", messageId: created.id, errorCode: result.errorCode, message: result.errorMessage };
  }
  return {
    kind: "failed",
    messageId: created.id,
    errorCode: result.errorCode,
    message: result.errorMessage,
    retryable: result.retryable,
  };
}
