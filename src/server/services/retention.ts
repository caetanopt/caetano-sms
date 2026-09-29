import { cutoff, type RetentionPolicy } from "@/features/retention/policy";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber } from "@/lib/phone/normalize";

export type RetentionReport = {
  apply: boolean;
  smsToAnonymize: number;
  deliveryEventsToDelete: number;
  loginAttemptsToDelete: number;
  auditIpsToClear: number;
};

const BATCH = 500;

/**
 * Aplica (ou simula, por defeito) a política de retenção. Idempotente.
 * Mensagens em curso (PENDING/QUEUED/SENT e campanhas ativas) nunca são anonimizadas.
 */
export async function runRetention(policy: RetentionPolicy, options: { apply: boolean; now?: Date }): Promise<RetentionReport> {
  const now = options.now ?? new Date();
  const smsWhere = {
    anonymizedAt: null,
    createdAt: { lt: cutoff(now, policy.smsDays) },
    status: { notIn: ["PENDING" as const, "QUEUED" as const, "SENT" as const] },
    OR: [{ campaignId: null }, { campaign: { status: { notIn: ["READY" as const, "SENDING" as const] } } }],
  };
  const eventsWhere = { createdAt: { lt: cutoff(now, policy.deliveryEventDays) } };
  const loginWhere = { createdAt: { lt: cutoff(now, policy.loginAttemptDays) } };
  const auditWhere = { ipAddress: { not: null }, createdAt: { lt: cutoff(now, policy.auditIpDays) } };

  const report: RetentionReport = {
    apply: options.apply,
    smsToAnonymize: await prisma.smsMessage.count({ where: smsWhere }),
    deliveryEventsToDelete: await prisma.smsDeliveryEvent.count({ where: eventsWhere }),
    loginAttemptsToDelete: await prisma.loginAttempt.count({ where: loginWhere }),
    auditIpsToClear: await prisma.auditLog.count({ where: auditWhere }),
  };
  if (!options.apply) return report;

  // Anonimização por lotes: o número fica mascarado (+351******678), o texto é removido.
  for (;;) {
    const batch = await prisma.smsMessage.findMany({
      where: smsWhere,
      take: BATCH,
      select: { id: true, destinationPhoneE164: true },
    });
    if (batch.length === 0) break;
    await prisma.$transaction(
      batch.map((message) =>
        prisma.smsMessage.update({
          where: { id: message.id },
          data: {
            body: "[anonimizado]",
            destinationPhoneE164: maskPhoneNumber(message.destinationPhoneE164),
            errorMessage: null,
            anonymizedAt: now,
          },
        }),
      ),
    );
  }
  await prisma.smsDeliveryEvent.deleteMany({ where: eventsWhere });
  await prisma.loginAttempt.deleteMany({ where: loginWhere });
  await prisma.auditLog.updateMany({ where: auditWhere, data: { ipAddress: null } });
  // Destinatários de campanhas terminadas há muito: remover hashes de telefone.
  await prisma.campaignRecipient.updateMany({
    where: { phoneHash: { not: null }, campaign: { finishedAt: { lt: cutoff(now, policy.smsDays) } } },
    data: { phoneHash: null, renderedBody: null },
  });
  await prisma.auditLog.create({
    data: {
      action: "RETENTION_APPLIED",
      entityType: "System",
      metadataJson: {
        smsAnonymized: report.smsToAnonymize,
        deliveryEventsDeleted: report.deliveryEventsToDelete,
        loginAttemptsDeleted: report.loginAttemptsToDelete,
        auditIpsCleared: report.auditIpsToClear,
        ...policy,
      },
    },
  });
  return report;
}
