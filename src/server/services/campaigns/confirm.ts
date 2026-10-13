import { Prisma } from "@/generated/prisma/client";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import type { Actor, ServiceResult } from "../contacts";
import { phoneHash } from "./origin";
import { buildCampaignPreview } from "./preview";

export type ConfirmCampaignInput = {
  campaignId: string;
  /** Fingerprint devolvido pela revisão que o operador viu. */
  fingerprint: string;
  /** Texto da 2.ª confirmação (obrigatório acima do limiar). */
  confirmationText: string;
  /** Promocionais: o operador confirma que o consentimento abrange marketing. */
  purposeAcknowledged: boolean;
};

export type ConfirmOutcome = { status: "confirmed" };

/**
 * Confirma uma campanha (CLAUDE.md §29). Guardar o rascunho nunca inicia envio:
 * só esta ação cria os destinatários e passa a campanha a READY.
 */
export async function confirmCampaign(
  actor: Actor,
  input: ConfirmCampaignInput,
): Promise<ServiceResult<ConfirmOutcome>> {
  if (!can(actor.role, "campaigns:send")) {
    return { ok: false, message: "O teu perfil não permite enviar campanhas." };
  }

  // Quem confirma é quem paga a quota: a revisão é calculada para o ator.
  const preview = await buildCampaignPreview(input.campaignId, { userId: actor.id });
  if (!preview) return { ok: false, message: "Campanha não encontrada." };
  if (preview.campaign.status !== "DRAFT") {
    // Nunca é tratado como sucesso: não pode reiniciar um envio pausado/parado.
    return { ok: false, message: "Esta campanha já foi confirmada. Consulta o estado atual." };
  }
  if (preview.plan.blockers.length > 0) {
    if (preview.quotaShortfall > 0) {
      await prisma.auditLog.create({
        data: {
          userId: actor.id,
          action: "CAMPAIGN_CONFIRMATION_REJECTED",
          entityType: "Campaign",
          entityId: input.campaignId,
          metadataJson: { reason: "quota", shortfall: preview.quotaShortfall },
        },
      });
    }
    return { ok: false, message: preview.plan.blockers.join(" ") };
  }

  // Tudo é recalculado no servidor: se algo mudou desde a revisão, pede-se nova revisão.
  if (preview.fingerprint !== input.fingerprint) {
    return {
      ok: false,
      message: "A campanha, a lista ou a configuração mudaram desde a revisão. Revê novamente antes de confirmar.",
    };
  }
  if (preview.requiredConfirmationText && input.confirmationText.trim() !== preview.requiredConfirmationText) {
    await prisma.auditLog.create({
      data: {
        userId: actor.id,
        action: "CAMPAIGN_CONFIRMATION_REJECTED",
        entityType: "Campaign",
        entityId: input.campaignId,
        metadataJson: { reason: "confirmation_text" },
      },
    });
    return { ok: false, message: `Para confirmar escreve exatamente: ${preview.requiredConfirmationText}` };
  }
  if (preview.campaign.messageType === "PROMOTIONAL" && !input.purposeAcknowledged) {
    return {
      ok: false,
      message: "Confirma que o consentimento dos destinatários abrange comunicações de marketing.",
    };
  }

  const { plan, origin, campaign, members } = preview;
  const now = new Date();
  const staleMessage = "A campanha, a lista ou a configuração mudaram desde a revisão. Revê novamente antes de confirmar.";

  let status: "confirmed" | "not_confirmed";
  try {
  status = await prisma.$transaction(
    async (tx) => {
      // CAS: só um pedido confirma; o updatedAt garante que o rascunho não mudou entretanto.
      const { count } = await tx.campaign.updateMany({
        where: { id: campaign.id, status: "DRAFT", updatedAt: campaign.updatedAt },
        data: {
          status: "READY",
          messageBody: campaign.body,
          mode: origin.mode,
          provider: origin.provider,
          originationHash: origin.originationHash,
          confirmedById: actor.id,
          confirmedAt: now,
          pausedAt: null,
          pausedById: null,
          lastError: null,
        },
      });
      if (count === 0) return "not_confirmed" as const;

      await tx.campaignRecipient.createMany({
        data: plan.recipients.map((recipient) =>
          recipient.eligible
            ? {
                campaignId: campaign.id,
                contactId: recipient.contactId,
                status: "PENDING" as const,
                renderedBody: recipient.renderedBody,
                segments: recipient.segments.segments,
                phoneHash: phoneHash(members.get(recipient.contactId)?.phoneE164 ?? ""),
              }
            : {
                campaignId: campaign.id,
                contactId: recipient.contactId,
                status: "SKIPPED" as const,
                skipReason: recipient.reason,
              },
        ),
      });

      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: "CAMPAIGN_CONFIRMED",
          entityType: "Campaign",
          entityId: campaign.id,
          metadataJson: {
            ...plan.counts,
            mode: origin.mode,
            provider: origin.provider,
            messageType: campaign.messageType,
            purposeAcknowledged: campaign.messageType === "PROMOTIONAL" ? input.purposeAcknowledged : null,
            secondConfirmation: preview.requiredConfirmationText !== null,
            fingerprint: preview.fingerprint.slice(0, 16),
            maxSendsPerMinute: preview.pace.campaign,
            quotaRemainingBefore: preview.quota?.remaining ?? null,
          },
        },
      });
      return "confirmed" as const;
    },
    { timeout: 30_000 },
  );
  } catch (error) {
    // Ex.: contacto eliminado entre a revisão e a transação (FK) → pedir nova revisão.
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2003"].includes(error.code)) {
      return { ok: false, message: staleMessage };
    }
    throw error;
  }

  if (status !== "confirmed") {
    const current = await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true } });
    return {
      ok: false,
      message: current?.status === "DRAFT" ? staleMessage : "Esta campanha já foi confirmada. Consulta o estado atual.",
    };
  }
  return { ok: true, value: { status } };
}
