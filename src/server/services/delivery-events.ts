import { Prisma } from "@/generated/prisma/client";
import { FINAL_STATUSES, replaceableStatuses, type SmsDeliveryEvent } from "@/features/delivery/events";
import { prisma } from "@/lib/db/prisma";
import { consoleLogger, type Logger } from "@/lib/logging/logger";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import { prismaManualSendStore } from "@/server/repositories/prisma-manual-send-store";

export type DeliveryHandleResult =
  | { kind: "duplicate" }
  | { kind: "unmatched" }
  | { kind: "ignored"; reason: "unknown_event_type" | "older_or_final_state" | "message_id_mismatch" }
  | { kind: "applied"; status: string };

/** CLAUDE.md §21. */
export interface SmsDeliveryEventHandler {
  handle(event: SmsDeliveryEvent, meta: { snsMessageId: string }): Promise<DeliveryHandleResult>;
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Aplica eventos de forma idempotente e tolerante à ordem:
 * - a mesma notificação SNS (MessageId) só é processada uma vez;
 * - o estado nunca recua e estados finais nunca são substituídos (CAS por precedência);
 * - um evento para uma mensagem em estado UNKNOWN (resultado incerto) prova que saiu.
 */
export class PrismaSmsDeliveryEventHandler implements SmsDeliveryEventHandler {
  constructor(private readonly logger: Logger = consoleLogger) {}

  async handle(event: SmsDeliveryEvent, meta: { snsMessageId: string }): Promise<DeliveryHandleResult> {
    let outcome: DeliveryHandleResult & { optOut?: { phone: string; contactId: string | null; userId: string; messageId: string } };
    try {
      outcome = await prisma.$transaction(async (tx) => {
        const record = await tx.smsDeliveryEvent.create({
          data: {
            snsMessageId: meta.snsMessageId,
            awsMessageId: event.awsMessageId,
            eventType: event.eventType,
            messageStatus: event.messageStatus,
            isFinal: event.isFinal,
            eventAt: event.eventAt,
            priceUsd: event.priceUsd === null ? null : new Prisma.Decimal(event.priceUsd.toFixed(6)),
          },
        });

        const byAwsId = await tx.smsMessage.findUnique({
          where: { awsMessageId: event.awsMessageId },
          select: { id: true, status: true, awsMessageId: true, destinationPhoneE164: true, contactId: true, createdById: true },
        });
        // Mensagens incertas não têm awsMessageId: usar o id interno enviado em Context.
        const message =
          byAwsId ??
          (event.internalMessageId
            ? await tx.smsMessage.findUnique({
                where: { id: event.internalMessageId },
                select: { id: true, status: true, awsMessageId: true, destinationPhoneE164: true, contactId: true, createdById: true },
              })
            : null);
        if (!message) return { kind: "unmatched" as const };
        await tx.smsDeliveryEvent.update({ where: { id: record.id }, data: { smsMessageId: message.id } });

        if (message.awsMessageId && message.awsMessageId !== event.awsMessageId) {
          return { kind: "ignored" as const, reason: "message_id_mismatch" as const };
        }
        if (!event.status) return { kind: "ignored" as const, reason: "unknown_event_type" as const };

        const at = event.eventAt ?? new Date();
        const final = (FINAL_STATUSES as readonly string[]).includes(event.status);
        const failed = final && event.status !== "DELIVERED";
        const { count } = await tx.smsMessage.updateMany({
          where: {
            id: message.id,
            status: { in: replaceableStatuses(event.status) as Prisma.EnumSmsMessageStatusFilter["in"] },
          },
          data: {
            status: event.status,
            awsMessageId: message.awsMessageId ?? event.awsMessageId,
            lastEventType: event.eventType,
            lastEventAt: at,
            deliveredAt: event.status === "DELIVERED" ? at : undefined,
            failedAt: failed ? at : undefined,
            errorCode: failed ? event.eventType : undefined,
            errorMessage: failed ? (event.messageStatus ?? "Falha reportada pela operadora.") : undefined,
          },
        });
        if (count === 0) return { kind: "ignored" as const, reason: "older_or_final_state" as const };
        await tx.smsDeliveryEvent.update({ where: { id: record.id }, data: { applied: true } });

        // Um evento para um envio incerto prova que foi enviado.
        if (message.status === "UNKNOWN") {
          await tx.campaignRecipient.updateMany({
            where: { messageId: message.id, status: "UNKNOWN" },
            data: { status: "ACCEPTED", errorCode: null, errorMessage: null },
          });
        }
        return {
          kind: "applied" as const,
          status: event.status,
          optOut: event.optedOut
            ? { phone: message.destinationPhoneE164, contactId: message.contactId, userId: message.createdById, messageId: message.id }
            : undefined,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: "duplicate" };
      throw error;
    }

    if (outcome.kind === "applied" && outcome.optOut) {
      const { phone, contactId, userId, messageId } = outcome.optOut;
      await prismaManualSendStore.recordProviderOptOut(phone, contactId, {
        userId,
        action: "CONTACT_OPTED_OUT_BY_PROVIDER",
        entityType: contactId ? "Contact" : "SuppressionEntry",
        entityId: contactId ?? undefined,
        metadata: { messageId, source: "delivery-event", destination: maskPhoneNumber(phone) },
      });
    }

    this.logger.log(outcome.kind === "unmatched" ? "warn" : "info", `sms.event.${outcome.kind}`, {
      awsMessageId: event.awsMessageId,
      status: outcome.kind === "applied" ? outcome.status : undefined,
      errorCode: outcome.kind === "ignored" ? outcome.reason : undefined,
    });
    if (outcome.kind === "applied") return { kind: "applied", status: outcome.status };
    return outcome;
  }
}
