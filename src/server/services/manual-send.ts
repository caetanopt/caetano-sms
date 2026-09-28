import type { Logger } from "@/lib/logging/logger";
import { maskPhoneNumber, normalizePhoneNumber } from "@/lib/phone/normalize";
import type { SmsRuntimeConfig } from "@/lib/sms/config";
import { assertSmsLength, type SmsSegmentInfo } from "@/lib/sms/encoding";
import { checkManualSendEligibility, type EligibilityContact } from "@/lib/sms/eligibility";
import {
  contactVariables,
  describeMissing,
  MANUAL_VARIABLES,
  renderTemplate,
  type TemplateValues,
} from "@/lib/sms/templates";
import type { SmsErrorCode, SmsMessageType, SmsProvider, SmsSendResult } from "@/lib/sms/types";

// ---------------------------------------------------------------------------
// Portas (implementação Prisma em src/server/repositories)
// ---------------------------------------------------------------------------

export type StoredContact = EligibilityContact & { id: string; name: string };

export type StoredTemplate = { id: string; name: string; body: string; messageType: SmsMessageType };

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

export interface ManualSendStore {
  findContactByPhone(phoneE164: string): Promise<StoredContact | null>;
  isSuppressed(phoneE164: string): Promise<boolean>;
  findTemplate(templateId: string): Promise<StoredTemplate | null>;
  findMessageByIdempotencyKey(key: string): Promise<{ id: string; status: string } | null>;
  /** Devolve null se já existir uma mensagem com a mesma chave de idempotência. */
  createPendingMessage(data: PendingMessageData): Promise<{ id: string } | null>;
  completeMessage(id: string, update: MessageOutcomeUpdate, audit: AuditEntry): Promise<void>;
  /** Adiciona o número à suppression list e marca o contacto (se existir) em opt-out. */
  recordProviderOptOut(phoneE164: string, contactId: string | null, audit: AuditEntry): Promise<void>;
  writeAudit(entry: AuditEntry): Promise<void>;
}

export type ManualSendDeps = {
  store: ManualSendStore;
  config: SmsRuntimeConfig;
  /** Resolvido só depois das validações; pode lançar erro de configuração. */
  getProvider: () => SmsProvider;
  logger: Logger;
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

export type ManualSendInput = {
  requestId: string;
  phone: string;
  /** Texto livre. Ignorado quando `templateId` é indicado (o corpo vem da base de dados). */
  message: string;
  messageType: SmsMessageType;
  legalBasisConfirmed: boolean;
  userId: string;
  templateId?: string | null;
  /** Valores das variáveis manuais (date, time, place). Variáveis de contacto vêm do contacto. */
  variables?: TemplateValues;
};

export type RejectionReason =
  | "INVALID_PHONE"
  | "INVALID_MESSAGE"
  | "OPTED_OUT"
  | "NO_CONSENT"
  | "LEGAL_BASIS_REQUIRED"
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_TYPE_MISMATCH"
  | "TEMPLATE_VARIABLES";

export type ManualSendPreview = {
  phoneE164: string;
  contact: { name: string; consentStatus: StoredContact["consentStatus"] } | null;
  messageType: SmsMessageType;
  segments: SmsSegmentInfo;
  /** Texto final (variáveis resolvidas) que será enviado. */
  renderedMessage: string;
  template: { id: string; name: string } | null;
  mode: SmsRuntimeConfig["mode"];
  originationLabel: string;
  legalBasisConfirmed: boolean;
};

export type PrepareResult =
  | { ok: true; preview: ManualSendPreview; contactId: string | null; templateId: string | null }
  | { ok: false; reason: RejectionReason; message: string };

export type ManualSendOutcome =
  | { kind: "rejected"; reason: RejectionReason; message: string }
  | { kind: "duplicate"; messageId: string; status: string }
  | { kind: "configuration_error"; message: string }
  | { kind: "accepted"; messageId: string; providerMessageId: string; dryRun: boolean }
  | { kind: "failed"; messageId: string; errorCode: SmsErrorCode; message: string; retryable: boolean }
  | { kind: "uncertain"; messageId: string; errorCode: SmsErrorCode; message: string };

// ---------------------------------------------------------------------------
// Casos de uso
// ---------------------------------------------------------------------------

/**
 * Valida o pedido e devolve o resumo a apresentar antes da confirmação.
 * Ordem: normalizar número → procurar contacto → opt-out → consentimento/tipo.
 */
export async function prepareManualSend(
  input: Omit<ManualSendInput, "requestId" | "userId">,
  deps: Pick<ManualSendDeps, "store" | "config">,
): Promise<PrepareResult> {
  let phoneE164: string;
  try {
    phoneE164 = normalizePhoneNumber(input.phone);
  } catch {
    return { ok: false, reason: "INVALID_PHONE", message: "Número de telefone inválido." };
  }

  let template: StoredTemplate | null = null;
  if (input.templateId) {
    template = await deps.store.findTemplate(input.templateId);
    if (!template) {
      return { ok: false, reason: "TEMPLATE_NOT_FOUND", message: "O template selecionado já não existe." };
    }
    // Nunca converter o tipo definido no template (CLAUDE.md §11).
    if (template.messageType !== input.messageType) {
      return {
        ok: false,
        reason: "TEMPLATE_TYPE_MISMATCH",
        message: `O template "${template.name}" é ${template.messageType === "PROMOTIONAL" ? "promocional" : "transacional"}: o tipo de mensagem tem de ser o mesmo.`,
      };
    }
  }
  const body = template ? template.body : input.message;

  if (body.trim().length === 0) {
    return { ok: false, reason: "INVALID_MESSAGE", message: "A mensagem está vazia." };
  }

  const [contact, suppressed] = await Promise.all([
    deps.store.findContactByPhone(phoneE164),
    deps.store.isSuppressed(phoneE164),
  ]);
  const eligibility = checkManualSendEligibility({
    contact,
    suppressed,
    messageType: input.messageType,
    legalBasisConfirmed: input.legalBasisConfirmed,
  });
  if (!eligibility.ok) {
    return { ok: false, reason: eligibility.reason, message: eligibility.message };
  }

  // Só as variáveis manuais vêm do operador; as de contacto vêm sempre do contacto.
  const manualValues = Object.fromEntries(
    MANUAL_VARIABLES.flatMap((name) => (input.variables?.[name] !== undefined ? [[name, input.variables[name]]] : [])),
  ) as TemplateValues;
  const rendered = renderTemplate(body, { ...manualValues, ...contactVariables(contact) });
  if (!rendered.ok) {
    const parts: string[] = [];
    if (rendered.missing.length > 0) {
      const contactMissing = rendered.missing.some((name) => !MANUAL_VARIABLES.includes(name));
      parts.push(
        `Faltam valores para ${describeMissing(rendered.missing)}` +
          (contactMissing && !contact ? " — o número não corresponde a um contacto registado." : "."),
      );
    }
    parts.push(...rendered.errors);
    return { ok: false, reason: "TEMPLATE_VARIABLES", message: parts.join(" ") };
  }

  let segments: SmsSegmentInfo;
  try {
    segments = assertSmsLength(rendered.text);
  } catch (error) {
    return {
      ok: false,
      reason: "INVALID_MESSAGE",
      message: error instanceof Error ? error.message : "Mensagem inválida.",
    };
  }

  return {
    ok: true,
    contactId: contact?.id ?? null,
    templateId: template?.id ?? null,
    preview: {
      phoneE164,
      contact: contact ? { name: contact.name, consentStatus: contact.consentStatus } : null,
      messageType: input.messageType,
      segments,
      renderedMessage: rendered.text,
      template: template ? { id: template.id, name: template.name } : null,
      mode: deps.config.mode,
      originationLabel: deps.config.originationLabel,
      legalBasisConfirmed: input.legalBasisConfirmed,
    },
  };
}

/**
 * Executa um envio individual confirmado pelo operador.
 * Repete todas as validações (nunca confia no resumo mostrado ao browser) e garante
 * idempotência pela chave `requestId`.
 */
export async function executeManualSend(
  input: ManualSendInput,
  deps: ManualSendDeps,
): Promise<ManualSendOutcome> {
  const { store, config, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const existing = await store.findMessageByIdempotencyKey(input.requestId);
  if (existing) {
    logger.log("info", "sms.send.duplicate", {
      messageInternalId: existing.id,
      userId: input.userId,
      status: existing.status,
    });
    return { kind: "duplicate", messageId: existing.id, status: existing.status };
  }

  const prepared = await prepareManualSend(input, deps);
  if (!prepared.ok) {
    logger.log("info", "sms.send.blocked", { userId: input.userId, errorCode: prepared.reason });
    const audited: RejectionReason[] = ["OPTED_OUT", "NO_CONSENT", "LEGAL_BASIS_REQUIRED", "TEMPLATE_TYPE_MISMATCH"];
    if (audited.includes(prepared.reason)) {
      await store.writeAudit({
        userId: input.userId,
        action: "SMS_SEND_BLOCKED",
        entityType: "SmsMessage",
        metadata: { reason: prepared.reason, messageType: input.messageType },
      });
    }
    return { kind: "rejected", reason: prepared.reason, message: prepared.message };
  }

  const { preview, contactId, templateId } = prepared;
  const maskedDestination = maskPhoneNumber(preview.phoneE164);

  let provider: SmsProvider;
  try {
    provider = deps.getProvider();
  } catch {
    logger.log("error", "sms.provider.configuration_error", {
      userId: input.userId,
      provider: config.provider,
    });
    return {
      kind: "configuration_error",
      message: "O serviço de envio não está configurado corretamente. Contacta um administrador.",
    };
  }

  const created = await store.createPendingMessage({
    idempotencyKey: input.requestId,
    contactId,
    destinationPhoneE164: preview.phoneE164,
    messageType: preview.messageType,
    body: preview.renderedMessage,
    encodingEstimate: preview.segments.encoding,
    segmentCountEstimate: preview.segments.segments,
    provider: config.provider,
    dryRun: config.mode === "TEST",
    templateId,
    createdById: input.userId,
  });
  if (!created) {
    const raced = await store.findMessageByIdempotencyKey(input.requestId);
    return { kind: "duplicate", messageId: raced?.id ?? "", status: raced?.status ?? "PENDING" };
  }

  const baseLog = {
    messageInternalId: created.id,
    userId: input.userId,
    provider: config.provider,
    dryRun: config.mode === "TEST",
    maskedDestination,
    segments: preview.segments.segments,
  };

  const startedAt = performance.now();
  let result: SmsSendResult;
  try {
    result = await provider.send({
      destinationPhoneNumber: preview.phoneE164,
      messageBody: preview.renderedMessage,
      messageType: preview.messageType,
      dryRun: config.dryRun,
      context: { internalMessageId: created.id, source: "manual" },
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

  if (result.ok) {
    await store.completeMessage(
      created.id,
      { status: "ACCEPTED", awsMessageId: result.messageId, provider: result.provider, sentAt: now() },
      {
        userId: input.userId,
        action: "SMS_SEND_ACCEPTED",
        entityType: "SmsMessage",
        entityId: created.id,
        metadata: {
          destination: maskedDestination,
          provider: result.provider,
          messageType: preview.messageType,
          segments: preview.segments.segments,
          legalBasisConfirmed: input.legalBasisConfirmed,
          dryRun: config.mode === "TEST",
        },
      },
    );
    logger.log("info", "sms.send.accepted", {
      ...baseLog,
      awsMessageId: result.messageId,
      status: "ACCEPTED",
      durationMs,
    });
    return {
      kind: "accepted",
      messageId: created.id,
      providerMessageId: result.messageId,
      dryRun: config.mode === "TEST",
    };
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
    {
      userId: input.userId,
      action: result.uncertain ? "SMS_SEND_UNCERTAIN" : "SMS_SEND_FAILED",
      entityType: "SmsMessage",
      entityId: created.id,
      metadata: {
        destination: maskedDestination,
        errorCode: result.errorCode,
        providerErrorName: result.providerErrorName ?? null,
        retryable: result.retryable,
        uncertain: result.uncertain,
      },
    },
  );

  if (result.errorCode === "OPTED_OUT") {
    // Suppression list local: refletir o opt-out comunicado pelo fornecedor.
    await store.recordProviderOptOut(preview.phoneE164, contactId, {
      userId: input.userId,
      action: "CONTACT_OPTED_OUT_BY_PROVIDER",
      entityType: contactId ? "Contact" : "SuppressionEntry",
      entityId: contactId ?? undefined,
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
    return {
      kind: "uncertain",
      messageId: created.id,
      errorCode: result.errorCode,
      message: `${result.errorMessage} A mensagem ficou em estado UNKNOWN; confirma no histórico antes de reenviar.`,
    };
  }
  return {
    kind: "failed",
    messageId: created.id,
    errorCode: result.errorCode,
    message: result.errorMessage,
    retryable: result.retryable,
  };
}
