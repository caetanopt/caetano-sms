import { createHash } from "node:crypto";
import { getCampaignLimits } from "@/features/campaigns/limits";
import { confirmationQuotaBlocker, effectivePerMinute } from "@/features/rate-limit/quota";
import { getUserQuotaSnapshot, type UserQuotaSnapshot } from "../send-rate";
import { planCampaign, type CampaignMember, type CampaignPlan } from "@/features/campaigns/plan";
import { prisma } from "@/lib/db/prisma";
import type { TemplateValues } from "@/lib/sms/templates";
import { currentOrigin, phoneHash, type CampaignOrigin } from "./origin";

const CHUNK = 1000;

function chunks<T>(items: T[]) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) result.push(items.slice(i, i + CHUNK));
  return result;
}

export type CampaignPreview = {
  campaign: {
    id: string;
    name: string;
    status: string;
    messageType: "TRANSACTIONAL" | "PROMOTIONAL";
    body: string;
    templateName: string | null;
    listName: string | null;
    variables: TemplateValues;
    updatedAt: Date;
  };
  plan: CampaignPlan;
  members: Map<string, { name: string; phoneE164: string }>;
  origin: CampaignOrigin;
  fingerprint: string;
  /** Texto exato exigido na 2.ª confirmação (null abaixo do limiar). */
  requiredConfirmationText: string | null;
  /** Promocionais: finalidade do último opt-in dos elegíveis. */
  purposeBreakdown: Array<{ purpose: string; count: number }>;
  /** Ritmo máximo (mensagens/min): o da campanha só aperta o global. */
  pace: { campaign: number | null; global: number; effective: number };
  /** Quota diária de quem vai confirmar (só com `viewer`); informativa — a autoritativa é a da reserva. */
  quota: UserQuotaSnapshot | null;
  /** Partes em falta na quota para esta campanha caber (0 = cabe). */
  quotaShortfall: number;
};

export function campaignVariables(json: unknown): TemplateValues {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const values: TemplateValues = {};
  for (const key of ["date", "time", "place"] as const) {
    const value = (json as Record<string, unknown>)[key];
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

export function computeFingerprint(input: {
  campaignId: string;
  messageType: string;
  body: string;
  variables: TemplateValues;
  origin: Pick<CampaignOrigin, "mode" | "provider" | "originationHash">;
  /** O ritmo faz parte do que o operador revê. */
  maxSendsPerMinute: number | null;
  plan: CampaignPlan;
  /** contactId → E.164 revisto (o número faz parte do que é confirmado). */
  phones: ReadonlyMap<string, string>;
}) {
  const eligible = input.plan.recipients
    .flatMap((recipient) =>
      recipient.eligible
        ? [[recipient.contactId, recipient.renderedBody, phoneHash(input.phones.get(recipient.contactId) ?? "")]]
        : [],
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
  const skipped = input.plan.recipients
    .flatMap((recipient) => (recipient.eligible ? [] : [[recipient.contactId, recipient.reason]]))
    .sort((a, b) => a[0].localeCompare(b[0]));
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.campaignId,
        input.messageType,
        input.body,
        input.variables,
        input.origin.mode,
        input.origin.provider,
        input.origin.originationHash,
        input.maxSendsPerMinute,
        eligible,
        skipped,
      ]),
    )
    .digest("hex");
}

/**
 * Calcula, no servidor e a partir da base de dados, tudo o que o §29 exige mostrar
 * antes da confirmação. Usado tanto na revisão como (de novo) na confirmação.
 */
export async function buildCampaignPreview(
  campaignId: string,
  viewer?: { userId: string },
): Promise<CampaignPreview | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      template: { select: { name: true, body: true, messageType: true } },
      list: { select: { name: true } },
    },
  });
  if (!campaign) return null;

  // O corpo do template é lido no momento (o rascunho pode estar desatualizado).
  const body = campaign.template ? campaign.template.body : campaign.messageBody;
  const variables = campaignVariables(campaign.variablesJson);
  const limits = getCampaignLimits();
  const origin = currentOrigin();

  const memberRows = campaign.listId
    ? await prisma.contactListMember.findMany({
        where: { listId: campaign.listId },
        orderBy: { createdAt: "asc" },
        select: {
          contact: { select: { id: true, name: true, phoneE164: true, consentStatus: true, optedOutAt: true } },
        },
      })
    : [];
  const contacts = memberRows.map((row) => row.contact);

  const suppressed = new Set<string>();
  for (const batch of chunks(contacts.map((contact) => contact.phoneE164))) {
    const entries = await prisma.suppressionEntry.findMany({ where: { phoneE164: { in: batch } }, select: { phoneE164: true } });
    for (const entry of entries) suppressed.add(entry.phoneE164);
  }

  const members: CampaignMember[] = contacts.map((contact) => ({
    contactId: contact.id,
    name: contact.name,
    phoneE164: contact.phoneE164,
    consentStatus: contact.consentStatus,
    optedOutAt: contact.optedOutAt,
    suppressed: suppressed.has(contact.phoneE164),
  }));

  const plan = planCampaign({ body, members, manualValues: variables, limits });
  if (!campaign.listId) plan.blockers.unshift("A lista da campanha já não existe: escolhe outra lista.");
  if (campaign.template && campaign.template.messageType !== campaign.messageType) {
    plan.blockers.unshift("O tipo da campanha é diferente do tipo do template.");
  }

  const purposeBreakdown: CampaignPreview["purposeBreakdown"] = [];
  if (campaign.messageType === "PROMOTIONAL") {
    const eligibleIds = plan.recipients.flatMap((recipient) => (recipient.eligible ? [recipient.contactId] : []));
    const counts = new Map<string, number>();
    const withPurpose = new Set<string>();
    for (const batch of chunks(eligibleIds)) {
      const events = await prisma.consentEvent.findMany({
        where: { contactId: { in: batch }, status: "OPTED_IN" },
        orderBy: { createdAt: "desc" },
        distinct: ["contactId"],
        select: { contactId: true, purpose: true },
      });
      for (const event of events) {
        withPurpose.add(event.contactId);
        const purpose = event.purpose?.trim() || "sem finalidade registada";
        counts.set(purpose, (counts.get(purpose) ?? 0) + 1);
      }
    }
    const withoutRecord = eligibleIds.filter((id) => !withPurpose.has(id)).length;
    if (withoutRecord > 0) counts.set("sem registo de consentimento", withoutRecord);
    purposeBreakdown.push(
      ...[...counts.entries()].map(([purpose, count]) => ({ purpose, count })).sort((a, b) => b.count - a.count),
    );
  }

  // Quota de quem vai confirmar: a campanha tem de caber no que resta hoje, descontando as partes
  // já comprometidas noutras campanhas suas. Não entra no fingerprint (muda a cada envio).
  let quota: UserQuotaSnapshot | null = null;
  let quotaShortfall = 0;
  if (viewer) {
    quota = await getUserQuotaSnapshot(viewer.userId, limits.userDailyParts, new Date(), { excludeCampaignId: campaign.id });
    if (quota) {
      const available = Math.max(0, quota.remaining - quota.committedElsewhere.parts);
      if (plan.counts.totalSegments > available) {
        quotaShortfall = plan.counts.totalSegments - available;
        plan.blockers.unshift(
          confirmationQuotaBlocker({
            required: plan.counts.totalSegments,
            state: quota,
            committed: {
              parts: quota.committedElsewhere.parts,
              names: quota.committedElsewhere.campaigns.map((c) => (c.paused ? `${c.name} (pausada)` : c.name)).slice(0, 3),
              total: quota.committedElsewhere.campaigns.length,
            },
          }),
        );
      }
    }
  }

  const fingerprint = computeFingerprint({
    campaignId: campaign.id,
    messageType: campaign.messageType,
    body,
    variables,
    origin,
    maxSendsPerMinute: campaign.maxSendsPerMinute,
    plan,
    phones: new Map(contacts.map((contact) => [contact.id, contact.phoneE164])),
  });

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      messageType: campaign.messageType,
      body,
      templateName: campaign.template?.name ?? null,
      listName: campaign.list?.name ?? null,
      variables,
      updatedAt: campaign.updatedAt,
    },
    plan,
    members: new Map(contacts.map((contact) => [contact.id, { name: contact.name, phoneE164: contact.phoneE164 }])),
    origin,
    fingerprint,
    requiredConfirmationText:
      plan.counts.eligible > limits.bulkConfirmationThreshold ? `ENVIAR ${plan.counts.eligible} SMS` : null,
    purposeBreakdown,
    pace: {
      campaign: campaign.maxSendsPerMinute,
      global: limits.maxSendsPerMinute,
      effective: effectivePerMinute(limits.maxSendsPerMinute, campaign.maxSendsPerMinute),
    },
    quota,
    quotaShortfall,
  };
}
