"use server";

import { z } from "zod";
import { EMPTY_RECIPIENT_COUNTS } from "@/features/campaigns/processing-rules";
import type { CampaignProgress } from "@/features/campaigns/progress";
import { can } from "@/lib/auth/permissions";
import { getCurrentUser, requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { redirectWith } from "@/lib/http/redirect-with";
import { consoleLogger } from "@/lib/logging/logger";
import { MANUAL_VARIABLES, type TemplateValues } from "@/lib/sms/templates";
import {
  createCampaignDraft,
  deleteCampaignDraft,
  updateCampaignDraft,
} from "@/server/services/campaign-drafts";
import { confirmCampaign } from "@/server/services/campaigns/confirm";
import {
  defaultEngineDeps,
  processCampaignStep,
  reconcileCampaign,
  recipientCounts,
} from "@/server/services/campaigns/engine";
import {
  cancelCampaign,
  pauseCampaign,
  resumeCampaign,
  revertCampaignToDraft,
} from "@/server/services/campaigns/lifecycle";

export type CampaignFormState = { error?: string };
export type ConfirmFormState = { error?: string; confirmed?: boolean };

const idSchema = z.string().regex(/^[a-z0-9]{10,40}$/i);

const draftSchema = z.object({
  name: z.string().trim().min(1, "Indica o nome da campanha.").max(120),
  listId: z.string().min(1, "Seleciona uma lista.").max(40),
  templateId: z.string().max(40),
  messageBody: z.string().max(1530, "Mensagem demasiado longa."),
  messageType: z.enum(["TRANSACTIONAL", "PROMOTIONAL"], { error: "Seleciona o tipo de mensagem." }),
});

function readVariables(formData: FormData): TemplateValues {
  const values: TemplateValues = {};
  for (const name of MANUAL_VARIABLES) {
    const value = formData.get(`var_${name}`);
    if (typeof value === "string" && value.trim() !== "") values[name] = value.slice(0, 200);
  }
  return values;
}

export async function saveCampaignDraftAction(_previous: CampaignFormState, formData: FormData): Promise<CampaignFormState> {
  const user = await requireUser();
  const parsed = draftSchema.safeParse({
    name: formData.get("name"),
    listId: formData.get("listId"),
    templateId: formData.get("templateId") ?? "",
    messageBody: formData.get("messageBody") ?? "",
    messageType: formData.get("messageType"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

  const input = { ...parsed.data, templateId: parsed.data.templateId || null, variables: readVariables(formData) };
  const campaignId = formData.get("campaignId");
  if (typeof campaignId === "string" && campaignId !== "") {
    if (!idSchema.safeParse(campaignId).success) return { error: "Pedido inválido." };
    const result = await updateCampaignDraft(user, campaignId, input);
    if (!result.ok) return { error: result.message };
    redirectWith(`/campaigns/${campaignId}`, { success: "Rascunho guardado. Revê o resumo antes de confirmar." });
  }
  const result = await createCampaignDraft(user, input);
  if (!result.ok) return { error: result.message };
  redirectWith(`/campaigns/${result.value.id}`, { success: "Rascunho criado. Revê o resumo antes de confirmar." });
}

export async function deleteCampaignDraftAction(campaignId: string, formData: FormData) {
  const user = await requireUser();
  if (formData.get("confirm") !== "on") {
    redirectWith(`/campaigns/${encodeURIComponent(campaignId)}`, { error: "Confirma a eliminação assinalando a caixa." });
  }
  const result = await deleteCampaignDraft(user, campaignId);
  if (!result.ok) redirectWith(`/campaigns/${encodeURIComponent(campaignId)}`, { error: result.message });
  redirectWith("/campaigns", { success: "Rascunho eliminado." });
}

export async function confirmCampaignAction(_previous: ConfirmFormState, formData: FormData): Promise<ConfirmFormState> {
  const user = await requireUser();
  const campaignId = String(formData.get("campaignId") ?? "");
  if (!idSchema.safeParse(campaignId).success) return { error: "Pedido inválido." };
  const result = await confirmCampaign(user, {
    campaignId,
    fingerprint: String(formData.get("fingerprint") ?? "").slice(0, 128),
    confirmationText: String(formData.get("confirmationText") ?? "").slice(0, 100),
    purposeAcknowledged: formData.get("purposeAcknowledged") === "on",
  });
  if (!result.ok) return { error: result.message };
  return { confirmed: result.value.status === "confirmed" };
}

async function progressFor(campaignId: string, state: CampaignProgress["state"], extra: Partial<CampaignProgress> = {}) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { status: true, lastError: true, pausedAt: true },
  });
  return {
    state,
    status: campaign?.status ?? "NOT_FOUND",
    counts: campaign ? await recipientCounts(campaignId) : { ...EMPTY_RECIPIENT_COUNTS },
    lastError: campaign?.lastError ?? null,
    paused: Boolean(campaign?.pausedAt),
    retryAfterMs: 0,
    ...extra,
  } satisfies CampaignProgress;
}

const FORBIDDEN: CampaignProgress = {
  state: "forbidden",
  status: "UNKNOWN",
  counts: { ...EMPTY_RECIPIENT_COUNTS },
  lastError: null,
  paused: false,
  retryAfterMs: 0,
  message: "Sessão expirada ou sem permissão — inicia sessão para retomar.",
};

/** Utilizador ativo lido da base de dados (nunca só o JWT). */
async function activeUser() {
  const user = await getCurrentUser();
  return user && !user.mustChangePassword ? user : null;
}

/** Autenticação e perfil verificados em cada chamada (a partir da base de dados). */
async function sender() {
  const user = await activeUser();
  return user && can(user.role, "campaigns:send") ? user : null;
}

/** Um passo curto de processamento. Só é chamado pelo loop iniciado explicitamente no browser. */
export async function processCampaignStepAction(campaignId: string): Promise<CampaignProgress> {
  if (!idSchema.safeParse(campaignId).success) return FORBIDDEN;
  if (!(await sender())) return FORBIDDEN;
  try {
    const step = await processCampaignStep(campaignId, defaultEngineDeps());
    switch (step.state) {
      case "done":
        return progressFor(campaignId, "finished");
      case "paused":
        return progressFor(campaignId, "paused", { message: step.reason ?? undefined });
      case "busy":
        return progressFor(campaignId, "busy", {
          retryAfterMs: step.waitMs,
          message: "Outra sessão está a processar esta campanha.",
        });
      case "wait":
        return progressFor(campaignId, "wait", { retryAfterMs: step.waitMs, message: step.reason });
      case "continue":
        return progressFor(campaignId, "progress", { retryAfterMs: 300 });
    }
  } catch {
    return progressFor(campaignId, "error", { retryAfterMs: 5_000, message: "Erro interno ao processar. A tentar de novo…" });
  }
}

/** Progresso só de leitura (também para VIEWER). Nunca envia. */
export async function campaignProgressAction(campaignId: string): Promise<CampaignProgress> {
  if (!idSchema.safeParse(campaignId).success) return FORBIDDEN;
  if (!(await activeUser())) return FORBIDDEN;
  // Campanhas canceladas com envios presos (ex.: reinício do servidor) são reconciliadas
  // aqui: nunca envia, só recupera estados.
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true, finishedAt: true } });
  if (campaign?.status === "CANCELLED" && !campaign.finishedAt) {
    await reconcileCampaign(campaignId, { now: () => new Date(), logger: consoleLogger });
  }
  return progressFor(campaignId, "progress");
}

type LifecycleResult = { ok: true } | { ok: false; message: string };

async function lifecycle(
  campaignId: string,
  run: (actor: { id: string; role: "ADMIN" | "OPERATOR" | "VIEWER" }, id: string) => Promise<{ ok: true } | { ok: false; message: string }>,
): Promise<LifecycleResult> {
  if (!idSchema.safeParse(campaignId).success) return { ok: false, message: "Pedido inválido." };
  const user = await requireUser();
  const result = await run(user, campaignId);
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

export async function pauseCampaignAction(campaignId: string) {
  return lifecycle(campaignId, pauseCampaign);
}
export async function resumeCampaignAction(campaignId: string) {
  return lifecycle(campaignId, resumeCampaign);
}
export async function cancelCampaignAction(campaignId: string) {
  return lifecycle(campaignId, cancelCampaign);
}
export async function revertCampaignAction(campaignId: string) {
  return lifecycle(campaignId, revertCampaignToDraft);
}
