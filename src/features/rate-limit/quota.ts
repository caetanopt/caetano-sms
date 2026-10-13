import { lisbonDayWindow } from "@/lib/time/lisbon";

/**
 * Limites por utilizador e por campanha (CLAUDE.md §19 "versão posterior", §8.6):
 * - quota diária de partes SMS por utilizador (dia civil em Europe/Lisbon), paga por quem
 *   envia (individual) ou por quem confirma a campanha;
 * - ritmo máximo por campanha (mensagens/minuto), que só pode apertar o limite global.
 * Código puro: regras e mensagens; a contagem e a aplicação atómica vivem em send-rate.ts.
 */

/** FAILED com estes códigos nunca chegou à operadora: a retentativa cria nova linha e é cobrada então. */
export const NOT_SENT_ERROR_CODES = [
  "THROTTLED",
  "PROVIDER_UNAVAILABLE",
  "AUTH_ERROR",
  "CONFIGURATION_ERROR",
  "SPEND_LIMIT",
  "QUOTA_EXCEEDED",
] as const;

export type QuotaState = {
  limit: number;
  used: number;
  remaining: number;
  /** Dia civil (YYYY-MM-DD, Lisboa) a que a contagem se refere. */
  day: string;
  /** Instante do próximo reinício (00:00 Lisboa do dia seguinte). */
  resetsAt: Date;
};

export const QUOTA_RESET_TEXT = "reinicia às 00:00 (hora de Lisboa)";
export const USER_QUOTA_HALT_CODE = "USER_QUOTA_EXHAUSTED";
export const CONFIRMER_INACTIVE_HALT_CODE = "CONFIRMER_INACTIVE";
export const CONFIRMER_INACTIVE_HALT_MESSAGE =
  "Envio parado: a conta de quem confirmou a campanha foi desativada ou deixou de poder enviar SMS. Os SMS já enviados não se repetem; cancela a campanha e cria uma nova para os destinatários restantes.";
export const USER_BLOCKED_MESSAGE = "A tua conta não pode enviar SMS. Contacta um administrador.";
export const RESUME_BLOCKED_CONFIRMER_INACTIVE =
  "Não é possível retomar: a conta de quem confirmou a campanha foi desativada ou deixou de poder enviar SMS. Cancela a campanha e cria uma nova para os destinatários restantes.";
const NO_QUOTA_TEXT = "a conta não tem quota de envio de SMS (definida por um administrador)";

/** null = defeito da aplicação; 0 = sem envios (decisão explícita de um administrador). */
export function effectiveDailyLimit(override: number | null, defaultLimit: number): number {
  return override ?? defaultLimit;
}

/** O ritmo de uma campanha nunca alarga o limite global. */
export function effectivePerMinute(global: number, campaign: number | null): number {
  return campaign === null ? global : Math.min(global, campaign);
}

export function quotaState(input: { limit: number; used: number; now: Date }): QuotaState {
  const { day, end } = lisbonDayWindow(input.now);
  return { limit: input.limit, used: input.used, remaining: Math.max(0, input.limit - input.used), day, resetsAt: end };
}

/** Nunca "arredonda": um envio de 3 partes com 2 disponíveis é recusado. */
export function quotaAllows(state: QuotaState, cost: number): boolean {
  return state.used + cost <= state.limit;
}

const parts = (n: number) => `${n} ${n === 1 ? "parte" : "partes"} SMS`;

export function describeQuota(state: QuotaState): string {
  // Limite 0 é uma decisão de um administrador: não "reinicia" à meia-noite.
  if (state.limit === 0) return `Sem quota de envio: ${NO_QUOTA_TEXT}`;
  return `${state.used} de ${state.limit} partes SMS usadas hoje · ${state.remaining} disponíveis · ${QUOTA_RESET_TEXT}`;
}

export function quotaBlockedMessage(state: QuotaState, cost: number): string {
  if (state.limit === 0) return "A tua conta não tem quota de envio de SMS. Contacta um administrador.";
  if (cost > state.limit) {
    return `Esta mensagem precisa de ${parts(cost)}, acima da tua quota diária (${state.limit}). Encurta a mensagem ou pede a um administrador para ajustar a quota.`;
  }
  return `Quota diária de envio atingida: usaste ${state.used} de ${state.limit} partes SMS hoje e esta mensagem precisa de ${cost}. Reinicia às 00:00 (hora de Lisboa). Se precisares de mais, pede a um administrador.`;
}

export function userQuotaHaltMessage(state: QuotaState): string {
  if (state.limit === 0) {
    return `Envio parado: ${NO_QUOTA_TEXT.replace("a conta", "a conta de quem confirmou a campanha")}. Pede a um administrador para ajustar a quota e retoma. Os SMS já enviados não se repetem.`;
  }
  return `Envio parado: a quota diária de partes SMS de quem confirmou a campanha foi atingida (${state.used} de ${state.limit}). Reinicia às 00:00 (hora de Lisboa): retoma depois dessa hora ou pede a um administrador para ajustar a quota. Os SMS já enviados não se repetem.`;
}

export function resumeBlockedByQuotaMessage(state: QuotaState): string {
  if (state.limit === 0) return `Não é possível retomar: ${NO_QUOTA_TEXT.replace("a conta", "a conta de quem confirmou a campanha")}.`;
  return `Não é possível retomar: a quota diária de quem confirmou a campanha não chega para o próximo envio (${state.used} de ${state.limit} partes SMS usadas hoje); ${QUOTA_RESET_TEXT} ou pede a um administrador para a ajustar.`;
}

export function campaignPaceWaitReason(perMinute: number): string {
  return `Ritmo máximo desta campanha (${perMinute} mensagens por minuto).`;
}

export function campaignPaceTooHighMessage(global: number): string {
  return `O ritmo máximo da campanha não pode exceder o limite global (${global} mensagens por minuto).`;
}

/** Blocker da revisão §29 quando a campanha não cabe na quota de quem vai confirmar. */
export function confirmationQuotaBlocker(input: {
  required: number;
  state: QuotaState;
  /** `total` = número de campanhas (os nomes podem vir truncados). */
  committed: { parts: number; names: string[]; total?: number };
}): string {
  if (input.state.limit === 0) {
    return `A campanha precisa de ${parts(input.required)} e ${NO_QUOTA_TEXT.replace("a conta", "a tua conta")}. Pede a um administrador para ajustar a tua quota.`;
  }
  const available = Math.max(0, input.state.remaining - input.committed.parts);
  const others = (input.committed.total ?? input.committed.names.length) - input.committed.names.length;
  const committed =
    input.committed.parts > 0
      ? `; ${input.committed.parts} reservadas em ${input.committed.names.map((name) => `«${name}»`).join(", ")}${others > 0 ? ` e mais ${others} campanha(s)` : ""}`
      : "";
  return `A campanha precisa de ${parts(input.required)} e a tua quota diária tem ${available} disponíveis (${input.state.used} de ${input.state.limit} usadas hoje${committed}). Reduz a lista, espera pelo reinício às 00:00 (hora de Lisboa) ou pede a um administrador para ajustar a tua quota.`;
}
