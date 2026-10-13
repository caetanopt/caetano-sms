import { cutoff, type RetentionPolicy } from "@/features/retention/policy";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber } from "@/lib/phone/normalize";

export type RetentionReport = {
  apply: boolean;
  smsToAnonymize: number;
  deliveryEventsToDelete: number;
  loginAttemptsToDelete: number;
  auditIpsToClear: number;
  /** Revogações de sessão (logout) cujo token expirou há mais de 1 h: deixaram de ser necessárias. */
  revokedSessionsToDelete: number;
};

const BATCH = 500;
/**
 * Uma revogação só é apagada 1 h depois de o token expirar: se o relógio da máquina que corre a
 * retenção estiver adiantado em relação a uma instância da aplicação, apagar no instante exato
 * reativaria por momentos um token revogado que essa instância ainda considera válido.
 */
const REVOKED_SESSION_GRACE_MS = 60 * 60_000;

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
  const revokedWhere = { expiresAt: { lt: new Date(now.getTime() - REVOKED_SESSION_GRACE_MS) } };

  const report: RetentionReport = {
    apply: options.apply,
    smsToAnonymize: await prisma.smsMessage.count({ where: smsWhere }),
    deliveryEventsToDelete: await prisma.smsDeliveryEvent.count({ where: eventsWhere }),
    loginAttemptsToDelete: await prisma.loginAttempt.count({ where: loginWhere }),
    auditIpsToClear: await prisma.auditLog.count({ where: auditWhere }),
    revokedSessionsToDelete: await prisma.revokedSession.count({ where: revokedWhere }),
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
  await prisma.revokedSession.deleteMany({ where: revokedWhere });
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
        revokedSessionsDeleted: report.revokedSessionsToDelete,
        ...policy,
      },
    },
  });
  return report;
}
