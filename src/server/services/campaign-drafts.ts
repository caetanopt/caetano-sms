import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { MANUAL_VARIABLES, validateVariableValue, type TemplateValues } from "@/lib/sms/templates";
import type { SmsMessageType } from "@/lib/sms/types";
import type { Actor, ServiceResult } from "./contacts";

const NO_PERMISSION = { ok: false as const, message: "O teu perfil não permite gerir campanhas." };

export type CampaignDraftInput = {
  name: string;
  listId: string;
  /** null = texto livre. */
  templateId: string | null;
  messageBody: string;
  messageType: SmsMessageType;
  variables: TemplateValues;
};

/** Só variáveis manuais da whitelist; valores validados. */
export function sanitizeManualVariables(values: TemplateValues): { ok: true; value: TemplateValues } | { ok: false; message: string } {
  const result: TemplateValues = {};
  for (const name of MANUAL_VARIABLES) {
    const value = values[name]?.trim();
    if (!value) continue;
    const error = validateVariableValue(value);
    if (error) return { ok: false, message: `{{${name}}}: ${error}` };
    result[name] = value;
  }
  return { ok: true, value: result };
}

async function resolveDraft(input: CampaignDraftInput) {
  const list = await prisma.contactList.findUnique({ where: { id: input.listId }, select: { id: true } });
  if (!list) return { ok: false as const, message: "Lista não encontrada." };

  let messageBody = input.messageBody;
  if (input.templateId) {
    const template = await prisma.smsTemplate.findUnique({
      where: { id: input.templateId },
      select: { body: true, messageType: true, name: true },
    });
    if (!template) return { ok: false as const, message: "Template não encontrado." };
    if (template.messageType !== input.messageType) {
      return {
        ok: false as const,
        message: `O template "${template.name}" é ${template.messageType === "PROMOTIONAL" ? "promocional" : "transacional"}: o tipo da campanha tem de ser o mesmo.`,
      };
    }
    // O corpo vem sempre da base de dados, nunca do browser.
    messageBody = template.body;
  }
  if (messageBody.trim() === "") return { ok: false as const, message: "A mensagem está vazia." };
  if (messageBody.length > 1530) return { ok: false as const, message: "Mensagem demasiado longa." };

  const variables = sanitizeManualVariables(input.variables);
  if (!variables.ok) return variables;

  return {
    ok: true as const,
    data: {
      name: input.name,
      listId: input.listId,
      templateId: input.templateId,
      messageBody,
      messageType: input.messageType,
      variablesJson: variables.value,
    },
  };
}

export async function createCampaignDraft(
  actor: Actor,
  input: CampaignDraftInput,
): Promise<ServiceResult<{ id: string }>> {
  if (!can(actor.role, "campaigns:write")) return NO_PERMISSION;
  const resolved = await resolveDraft(input);
  if (!resolved.ok) return resolved;

  const campaign = await prisma.$transaction(async (tx) => {
    const created = await tx.campaign.create({ data: { ...resolved.data, createdById: actor.id } });
    await tx.auditLog.create({
      data: {
        userId: actor.id,
        action: "CAMPAIGN_CREATED",
        entityType: "Campaign",
        entityId: created.id,
        metadataJson: { name: created.name, messageType: created.messageType, listId: created.listId },
      },
    });
    return created;
  });
  return { ok: true, value: { id: campaign.id } };
}

/** Só rascunhos podem ser alterados (compare-and-set no estado). */
export async function updateCampaignDraft(
  actor: Actor,
  campaignId: string,
  input: CampaignDraftInput,
): Promise<ServiceResult> {
  if (!can(actor.role, "campaigns:write")) return NO_PERMISSION;
  const resolved = await resolveDraft(input);
  if (!resolved.ok) return resolved;

  const { count } = await prisma.campaign.updateMany({
    where: { id: campaignId, status: "DRAFT" },
    data: resolved.data,
  });
  if (count === 0) return { ok: false, message: "Só é possível editar campanhas em rascunho." };
  await prisma.auditLog.create({
    data: {
      userId: actor.id,
      action: "CAMPAIGN_UPDATED",
      entityType: "Campaign",
      entityId: campaignId,
      metadataJson: { messageType: resolved.data.messageType, listId: resolved.data.listId },
    },
  });
  return { ok: true, value: undefined };
}

export async function deleteCampaignDraft(actor: Actor, campaignId: string): Promise<ServiceResult> {
  if (!can(actor.role, "campaigns:write")) return NO_PERMISSION;
  const { count } = await prisma.campaign.deleteMany({ where: { id: campaignId, status: "DRAFT" } });
  if (count === 0) return { ok: false, message: "Só é possível eliminar campanhas em rascunho." };
  await prisma.auditLog.create({
    data: { userId: actor.id, action: "CAMPAIGN_DELETED", entityType: "Campaign", entityId: campaignId, metadataJson: {} },
  });
  return { ok: true, value: undefined };
}
