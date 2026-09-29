import { z } from "zod";

/**
 * Eventos de entrega do AWS End User Messaging SMS (Configuration Set → SNS).
 * Os tipos TEXT_* vêm do enum EventType do SDK instalado; os restantes campos são
 * lidos defensivamente (tudo opcional exceto eventType/messageId).
 */

export const TEXT_EVENT_STATUS = {
  TEXT_PENDING: "QUEUED",
  TEXT_QUEUED: "QUEUED",
  TEXT_SENT: "SENT",
  TEXT_SUCCESSFUL: "SENT",
  TEXT_DELIVERED: "DELIVERED",
  TEXT_BLOCKED: "FAILED",
  TEXT_CARRIER_BLOCKED: "FAILED",
  TEXT_SPAM: "FAILED",
  TEXT_INVALID_MESSAGE: "FAILED",
  TEXT_TTL_EXPIRED: "FAILED",
  TEXT_INVALID: "UNROUTABLE",
  TEXT_UNREACHABLE: "UNROUTABLE",
  TEXT_CARRIER_UNREACHABLE: "UNROUTABLE",
  TEXT_PROTECT_BLOCKED: "PROTECT_BLOCKED",
  TEXT_UNKNOWN: "UNKNOWN",
} as const;

export type TextEventType = keyof typeof TEXT_EVENT_STATUS;
export type DeliveryStatus = (typeof TEXT_EVENT_STATUS)[TextEventType];

export const smsEventSchema = z.object({
  eventType: z.string().min(1).max(100),
  messageId: z.string().min(1).max(200),
  eventTimestamp: z.number().optional(),
  isFinal: z.boolean().optional(),
  messageStatus: z.string().max(100).optional(),
  messageStatusDescription: z.string().max(500).optional(),
  totalMessagePrice: z.number().nonnegative().optional(),
  context: z.record(z.string(), z.string()).optional(),
});

export type SmsDeliveryEvent = {
  eventType: string;
  awsMessageId: string;
  status: DeliveryStatus | null;
  /** Identificador interno enviado em Context (útil quando falta awsMessageId). */
  internalMessageId: string | null;
  eventAt: Date | null;
  isFinal: boolean;
  messageStatus: string | null;
  priceUsd: number | null;
  /** O fornecedor indica que o destino está em opt-out. */
  optedOut: boolean;
};

export function parseSmsEvent(message: string): SmsDeliveryEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(message);
  } catch {
    return null;
  }
  const parsed = smsEventSchema.safeParse(json);
  if (!parsed.success) return null;
  const event = parsed.data;
  const status = event.eventType in TEXT_EVENT_STATUS ? TEXT_EVENT_STATUS[event.eventType as TextEventType] : null;
  const messageStatus = event.messageStatus ?? null;
  const internal = event.context?.internalMessageId;
  return {
    eventType: event.eventType,
    awsMessageId: event.messageId,
    status,
    internalMessageId: internal && /^[a-z0-9]{10,40}$/i.test(internal) ? internal : null,
    eventAt: event.eventTimestamp && Number.isFinite(event.eventTimestamp) ? new Date(event.eventTimestamp) : null,
    isFinal: event.isFinal ?? false,
    messageStatus,
    priceUsd: event.totalMessagePrice ?? null,
    optedOut: messageStatus !== null && /OPTED_OUT/.test(messageStatus),
  };
}

/**
 * Precedência de estados: eventos chegam fora de ordem; um estado nunca recua e um
 * estado final nunca é substituído. UNKNOWN interno (resultado incerto no envio) tem a
 * precedência de ACCEPTED: qualquer evento prova que a mensagem saiu.
 */
const RANK: Record<string, number> = {
  PENDING: 0,
  ACCEPTED: 1,
  UNKNOWN: 1,
  QUEUED: 2,
  SENT: 3,
  DELIVERED: 4,
  FAILED: 4,
  UNROUTABLE: 4,
  PROTECT_BLOCKED: 4,
  CANCELLED: 4,
};

export const FINAL_STATUSES = ["DELIVERED", "FAILED", "UNROUTABLE", "PROTECT_BLOCKED", "CANCELLED"] as const;

/** Estados atuais que podem ser substituídos por `next`. */
export function replaceableStatuses(next: DeliveryStatus): string[] {
  // Um evento UNKNOWN nunca rebaixa QUEUED/SENT (a operadora apenas não reportou).
  const nextRank = next === "UNKNOWN" ? 1.5 : RANK[next];
  return Object.entries(RANK)
    .filter(([status, rank]) => rank < nextRank && !(FINAL_STATUSES as readonly string[]).includes(status))
    .map(([status]) => status);
}
