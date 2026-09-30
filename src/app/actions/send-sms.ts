"use server";

import { z } from "zod";
import {
  emptySendFormValues,
  type SendFormState,
  type SendFormValues,
} from "@/features/messages/send-form-state";
import { requireUser } from "@/lib/auth/session";
import { getCampaignLimits, type CampaignLimits } from "@/features/campaigns/limits";
import { consoleLogger } from "@/lib/logging/logger";
import { MANUAL_VARIABLES, type TemplateValues } from "@/lib/sms/templates";
import { getSmsRuntimeConfig } from "@/lib/sms/config";
import { getSmsProvider } from "@/lib/sms/provider";
import { prismaManualSendStore } from "@/server/repositories/prisma-manual-send-store";
import { getSendRateConfig } from "@/features/rate-limit/rules";
import { currentOrigin } from "@/server/services/campaigns/origin";
import { getUserQuotaSnapshot, recordProviderThrottle } from "@/server/services/send-rate";
import { quotaAllows, quotaBlockedMessage, USER_BLOCKED_MESSAGE } from "@/features/rate-limit/quota";
import {
  executeManualSend,
  prepareManualSend,
  type ManualSendDeps,
} from "@/server/services/manual-send";

const schema = z.object({
  requestId: z.string().uuid(),
  phone: z.string().trim().min(6).max(40),
  message: z.string().min(1).max(1530),
  messageType: z.enum(["TRANSACTIONAL", "PROMOTIONAL"], {
    error: "Seleciona o tipo de mensagem.",
  }),
  legalBasis: z.boolean(),
  templateId: z.string().max(40),
});

function readValues(formData: FormData): SendFormValues {
  const messageType = String(formData.get("messageType") ?? "");
  return {
    phone: String(formData.get("phone") ?? ""),
    message: String(formData.get("message") ?? ""),
    messageType: messageType === "TRANSACTIONAL" || messageType === "PROMOTIONAL" ? messageType : "",
    legalBasis: formData.get("legalBasis") === "on",
    templateId: String(formData.get("templateId") ?? ""),
    variables: readVariables(formData),
  };
}

/** Só aceita as variáveis manuais da whitelist (`var_date`, `var_time`, `var_place`). */
function readVariables(formData: FormData): TemplateValues {
  const values: TemplateValues = {};
  for (const name of MANUAL_VARIABLES) {
    const value = formData.get(`var_${name}`);
    if (typeof value === "string" && value !== "") values[name] = value.slice(0, 200);
  }
  return values;
}

function buildDeps(): { deps: ManualSendDeps; limits: CampaignLimits } | null {
  try {
    const limits = getCampaignLimits();
    const rateLimits = {
      maxPerMinute: limits.maxSendsPerMinute,
      rate: getSendRateConfig(),
      originKey: currentOrigin().originationHash,
      userDailyParts: limits.userDailyParts,
    };
    return {
      limits,
      deps: {
        store: prismaManualSendStore,
        config: getSmsRuntimeConfig(),
        getProvider: () => getSmsProvider(),
        logger: consoleLogger,
        rateLimits,
        onThrottled: (phoneE164) => recordProviderThrottle({ phoneE164 }, rateLimits),
      },
    };
  } catch {
    return null;
  }
}

const CONFIG_ERROR = "O serviço de envio não está configurado corretamente. Contacta um administrador.";

export async function sendSmsFormAction(
  previous: SendFormState,
  formData: FormData,
): Promise<SendFormState> {
  const user = await requireUser();
  const values = readValues(formData);
  const requestId = String(formData.get("requestId") ?? previous.requestId);
  const intent = String(formData.get("intent") ?? "review");
  const editState = (error?: string): SendFormState => ({ step: "edit", requestId, values, error });

  if (user.role === "VIEWER") return editState("O teu perfil não permite enviar SMS.");
  if (intent === "edit") return editState();

  const parsed = schema.safeParse({ ...values, requestId });
  if (!parsed.success) {
    const typeIssue = parsed.error.issues.find((issue) => issue.path[0] === "messageType");
    return editState(typeIssue ? "Seleciona o tipo de mensagem." : "Revê os dados do formulário.");
  }

  const built = buildDeps();
  if (!built) return editState(CONFIG_ERROR);
  const { deps, limits } = built;

  const input = {
    requestId,
    phone: parsed.data.phone,
    message: parsed.data.message,
    messageType: parsed.data.messageType,
    legalBasisConfirmed: parsed.data.legalBasis,
    userId: user.id,
    templateId: parsed.data.templateId || null,
    variables: values.variables,
  };

  if (intent === "review") {
    const prepared = await prepareManualSend(input, deps);
    if (!prepared.ok) return editState(prepared.message);
    const { preview } = prepared;
    // Pré-verificação informativa da quota (a autoritativa acontece na reserva, ao confirmar).
    const quota = await getUserQuotaSnapshot(user.id, limits.userDailyParts);
    if (!quota || !quota.active) return editState(USER_BLOCKED_MESSAGE);
    if (!quotaAllows(quota, preview.segments.segments)) return editState(quotaBlockedMessage(quota, preview.segments.segments));
    return {
      step: "review",
      requestId,
      values,
      review: {
        phoneE164: preview.phoneE164,
        contactName: preview.contact?.name ?? null,
        consentStatus: preview.contact?.consentStatus ?? null,
        messageType: preview.messageType,
        segments: preview.segments,
        renderedMessage: preview.renderedMessage,
        templateName: preview.template?.name ?? null,
        mode: preview.mode,
        originationLabel: preview.originationLabel,
        legalBasisConfirmed: preview.legalBasisConfirmed,
        quota: {
          used: quota.used,
          limit: quota.limit,
          remaining: quota.remaining,
          afterSend: quota.remaining - preview.segments.segments,
          committed: quota.committedElsewhere.parts,
        },
      },
    };
  }

  if (intent !== "confirm") return editState("Pedido inválido.");

  const outcome = await executeManualSend(input, deps);
  const done = (
    kind: NonNullable<SendFormState["result"]>["kind"],
    message: string,
    keepValues = false,
  ): SendFormState => ({
    step: "done",
    // Novo pedido => nova chave de idempotência.
    requestId: crypto.randomUUID(),
    values: keepValues ? values : emptySendFormValues,
    result: { kind, message },
  });

  switch (outcome.kind) {
    case "rejected":
      return editState(outcome.message);
    case "configuration_error":
    case "rate_limited":
      return editState(outcome.message);
    case "duplicate":
      return done("duplicate", "Este pedido já foi processado; não foi enviado novamente.");
    case "accepted":
      return done(
        "accepted",
        outcome.dryRun
          ? "Mensagem aceite em MODO DE TESTE — nenhum SMS real foi enviado."
          : "Mensagem aceite pela AWS. A entrega final será confirmada pelos eventos de entrega.",
      );
    case "failed":
      // Falha definitiva: manter os dados para o operador corrigir e decidir se repete.
      return done("failed", outcome.message, true);
    case "uncertain":
      return done("uncertain", outcome.message);
  }
}
