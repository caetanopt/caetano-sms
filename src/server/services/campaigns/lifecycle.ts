import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import type { Actor, ServiceResult } from "../contacts";

const NO_PERMISSION = { ok: false as const, message: "O teu perfil não permite gerir o envio de campanhas." };

async function audit(actor: Actor, action: string, campaignId: string, metadata: Record<string, string | null> = {}) {
  await prisma.auditLog.create({
    data: { userId: actor.id, action, entityType: "Campaign", entityId: campaignId, metadataJson: metadata },
  });
}

/** Pausa persistida: nenhum passo ou job envia enquanto estiver definida. */
export async function pauseCampaign(actor: Actor, campaignId: string): Promise<ServiceResult> {
  if (!can(actor.role, "campaigns:send")) return NO_PERMISSION;
  const { count } = await prisma.campaign.updateMany({
    where: { id: campaignId, status: { in: ["READY", "SENDING"] }, pausedAt: null },
    data: { pausedAt: new Date(), pausedById: actor.id, lastError: null },
  });
  if (count === 0) return { ok: false, message: "A campanha não está em envio ou já está em pausa." };
  await audit(actor, "CAMPAIGN_PAUSED", campaignId);
  return { ok: true, value: undefined };
}

/**
 * Início/retoma explícitos (abrir a página nunca envia). Audita quem retomou.
 */
export async function resumeCampaign(actor: Actor, campaignId: string): Promise<ServiceResult> {
  if (!can(actor.role, "campaigns:send")) return NO_PERMISSION;
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, pausedAt: true, startedAt: true, lastError: true },
  });
  if (!campaign || !["READY", "SENDING"].includes(campaign.status)) {
    return { ok: false, message: "A campanha não está pronta para envio." };
  }
  if (campaign.pausedAt) {
    await prisma.campaign.updateMany({
      where: { id: campaignId, status: { in: ["READY", "SENDING"] } },
      data: { pausedAt: null, pausedById: null, lastError: null, consecutiveUnknown: 0, nextStepAt: null },
    });
    // Nova oportunidade para quem ficou à espera por throttling prolongado.
    await prisma.campaignRecipient.updateMany({
      where: { campaignId, status: "PENDING", retries: { gt: 0 } },
      data: { retries: 0, nextAttemptAt: null },
    });
  }
  await audit(actor, campaign.startedAt ? "CAMPAIGN_RESUMED" : "CAMPAIGN_STARTED", campaignId, {
    previousError: campaign.lastError,
  });
  return { ok: true, value: undefined };
}

export async function cancelCampaign(actor: Actor, campaignId: string): Promise<ServiceResult> {
  if (!can(actor.role, "campaigns:send")) return NO_PERMISSION;
  const cancelled = await prisma.$transaction(async (tx) => {
    const { count } = await tx.campaign.updateMany({
      where: { id: campaignId, status: { in: ["READY", "SENDING"] } },
      data: { status: "CANCELLED", cancelledAt: new Date(), processingLeaseToken: null, processingLeaseUntil: null },
    });
    if (count === 0) return false;
    await tx.campaignRecipient.updateMany({
      where: { campaignId, status: "PENDING" },
      data: { status: "CANCELLED", renderedBody: null, claimToken: null },
    });
    const inFlight = await tx.campaignRecipient.count({ where: { campaignId, status: "PROCESSING" } });
    if (inFlight === 0) await tx.campaign.update({ where: { id: campaignId }, data: { finishedAt: new Date() } });
    return true;
  });
  if (!cancelled) return { ok: false, message: "Só é possível cancelar campanhas prontas ou em envio." };
  await audit(actor, "CAMPAIGN_CANCELLED", campaignId);
  return { ok: true, value: undefined };
}

/**
 * Volta a rascunho uma campanha confirmada em que nenhum SMS foi tentado (ex.: confirmação
 * expirada, modo/origem alterados antes do primeiro envio). Os destinatários são
 * descartados e a campanha tem de ser revista e confirmada de novo.
 */
export async function revertCampaignToDraft(actor: Actor, campaignId: string): Promise<ServiceResult> {
  if (!can(actor.role, "campaigns:send")) return NO_PERMISSION;
  const reverted = await prisma.$transaction(async (tx) => {
    if ((await tx.smsMessage.count({ where: { campaignId } })) > 0) return false;
    if ((await tx.campaignRecipient.count({ where: { campaignId, status: "PROCESSING" } })) > 0) return false;
    const { count } = await tx.campaign.updateMany({
      where: {
        id: campaignId,
        OR: [{ status: "READY" }, { status: "SENDING", pausedAt: { not: null } }],
      },
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
        nextStepAt: null,
        consecutiveUnknown: 0,
        startedAt: null,
        processingLeaseToken: null,
        processingLeaseUntil: null,
      },
    });
    if (count === 0) return false;
    await tx.campaignRecipient.deleteMany({ where: { campaignId } });
    return true;
  });
  if (!reverted) {
    return { ok: false, message: "Só é possível voltar a rascunho enquanto nenhum SMS da campanha foi tentado." };
  }
  await audit(actor, "CAMPAIGN_REVERTED_TO_DRAFT", campaignId);
  return { ok: true, value: undefined };
}
