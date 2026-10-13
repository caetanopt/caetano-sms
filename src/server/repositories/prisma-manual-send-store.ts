import { ConsentStatus, Prisma, SmsMessageStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AuditEntry, ManualSendStore } from "@/server/services/manual-send";
import { lockSendRateShared, reserveInTransaction, type RateBlocked } from "@/server/services/send-rate";

/** Interrompe a transação de criação quando a reserva recusa (nada fica gravado). */
class RateLimitedSignal extends Error {
  constructor(readonly check: RateBlocked) {
    super("rate_limited");
    this.name = "RateLimitedSignal";
  }
}

function auditData(entry: AuditEntry) {
  return {
    userId: entry.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    metadataJson: entry.metadata,
  };
}

export const prismaManualSendStore: ManualSendStore = {
  async findContactByPhone(phoneE164) {
    return prisma.contact.findUnique({
      where: { phoneE164 },
      select: { id: true, name: true, consentStatus: true, optedOutAt: true },
    });
  },

  async isSuppressed(phoneE164) {
    const entry = await prisma.suppressionEntry.findUnique({ where: { phoneE164 }, select: { id: true } });
    return entry !== null;
  },

  async findTemplate(templateId) {
    return prisma.smsTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, name: true, body: true, messageType: true },
    });
  },

  async findMessageByIdempotencyKey(key) {
    return prisma.smsMessage.findUnique({
      where: { idempotencyKey: key },
      select: { id: true, status: true },
    });
  },

  async createPendingMessage(data, reservation) {
    try {
      if (!reservation) {
        // Envio de campanha (já reservado no claim): inserir sob o lock partilhado para que uma
        // reserva concorrente nunca conte a quota a meio desta inserção (ver send-rate.ts).
        const row = await prisma.$transaction(async (tx) => {
          await lockSendRateShared(tx);
          return tx.smsMessage.create({ data: { ...data, status: SmsMessageStatus.PENDING }, select: { id: true } });
        });
        return { kind: "created", id: row.id };
      }
      const row = await prisma.$transaction(async (tx) => {
        const check = await reserveInTransaction(tx, reservation.target, reservation.payerId, reservation.limits, reservation.now);
        if (!check.ok) throw new RateLimitedSignal(check);
        // createdAt explícito: a fronteira do dia e a contagem usam o mesmo relógio da reserva.
        return tx.smsMessage.create({
          data: { ...data, status: SmsMessageStatus.PENDING, createdAt: reservation.now },
          select: { id: true },
        });
      });
      return { kind: "created", id: row.id };
    } catch (error) {
      if (error instanceof RateLimitedSignal) return { kind: "rate_limited", check: error.check };
      // P2002: violação da constraint única de idempotencyKey (pedido concorrente).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return { kind: "duplicate" };
      throw error;
    }
  },

  async completeMessage(id, update, audit) {
    if (!audit) {
      await prisma.smsMessage.update({ where: { id }, data: update });
      return;
    }
    await prisma.$transaction([
      prisma.smsMessage.update({ where: { id }, data: update }),
      prisma.auditLog.create({ data: auditData(audit) }),
    ]);
  },

  async recordProviderOptOut(phoneE164, contactId, audit) {
    await prisma.$transaction(async (tx) => {
      await tx.suppressionEntry.upsert({
        where: { phoneE164 },
        create: { phoneE164, source: "provider" },
        update: {},
      });
      if (contactId) {
        const { count } = await tx.contact.updateMany({
          where: { id: contactId, optedOutAt: null },
          data: { consentStatus: ConsentStatus.OPTED_OUT, optedOutAt: new Date(), consentSource: "provider" },
        });
        if (count > 0) {
          await tx.consentEvent.create({
            data: {
              contactId,
              status: ConsentStatus.OPTED_OUT,
              source: "provider",
              process: "provider",
              recordedById: audit.userId,
            },
          });
        }
      }
      await tx.auditLog.create({ data: auditData(audit) });
    });
  },

  async writeAudit(entry) {
    await prisma.auditLog.create({ data: auditData(entry) });
  },
};
