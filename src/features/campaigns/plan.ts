import { isValidPhoneNumber } from "libphonenumber-js";
import { getSmsSegmentInfo, type SmsSegmentInfo } from "@/lib/sms/encoding";
import {
  analyzeTemplate,
  contactVariables,
  renderTemplate,
  type TemplateValues,
  type TemplateVariable,
} from "@/lib/sms/templates";
import { destinationCountry } from "@/features/rate-limit/estimate";
import type { CampaignLimits } from "./limits";

const MAX_UNITS = { GSM_7: 1530, UCS_2: 630 } as const;

export type CampaignMember = {
  contactId: string;
  name: string;
  phoneE164: string;
  consentStatus: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
  optedOutAt: Date | null;
  /** O número consta da suppression list local. */
  suppressed: boolean;
};

export type SkipReason = "OPTED_OUT" | "NO_CONSENT" | "INVALID_PHONE";

export type PlannedRecipient =
  | { contactId: string; eligible: true; renderedBody: string; segments: SmsSegmentInfo }
  | { contactId: string; eligible: false; reason: SkipReason };

export type CampaignPlanCounts = {
  total: number;
  eligible: number;
  optedOut: number;
  noConsent: number;
  invalidPhone: number;
  /** Soma das partes estimadas dos destinatários elegíveis. */
  totalSegments: number;
  /** Partes estimadas por país de destino (para os limites de MPS). */
  segmentsByCountry: Record<string, number>;
};

export type CampaignPlan = {
  recipients: PlannedRecipient[];
  counts: CampaignPlanCounts;
  /** Contactos elegíveis com variáveis em falta (bloqueiam a confirmação). */
  missingVariables: Array<{ contactId: string; contactName: string; missing: TemplateVariable[] }>;
  /** Contactos elegíveis cuja mensagem final excede os limites SMS. */
  tooLong: Array<{ contactId: string; contactName: string; units: number; max: number }>;
  /** Motivos que impedem a confirmação. Vazio = pode confirmar. */
  blockers: string[];
};

/**
 * Classifica um membro da lista. Campanhas exigem SEMPRE opt-in explícito,
 * qualquer que seja o tipo de mensagem (CLAUDE.md §12).
 */
export function classifyMember(member: CampaignMember): SkipReason | null {
  if (!isValidPhoneNumber(member.phoneE164)) return "INVALID_PHONE";
  if (member.suppressed || member.optedOutAt !== null || member.consentStatus === "OPTED_OUT") return "OPTED_OUT";
  if (member.consentStatus !== "OPTED_IN") return "NO_CONSENT";
  return null;
}

export function planCampaign(input: {
  body: string;
  members: CampaignMember[];
  manualValues: TemplateValues;
  limits: Pick<CampaignLimits, "maxRecipients">;
}): CampaignPlan {
  const blockers: string[] = [];
  const analysis = analyzeTemplate(input.body);
  if (input.body.trim() === "") blockers.push("A mensagem está vazia.");
  blockers.push(...analysis.errors);

  const recipients: PlannedRecipient[] = [];
  const missingVariables: CampaignPlan["missingVariables"] = [];
  const tooLong: CampaignPlan["tooLong"] = [];
  const counts: CampaignPlanCounts = {
    total: input.members.length,
    eligible: 0,
    optedOut: 0,
    noConsent: 0,
    invalidPhone: 0,
    totalSegments: 0,
    segmentsByCountry: {},
  };

  for (const member of input.members) {
    const reason = classifyMember(member);
    if (reason) {
      recipients.push({ contactId: member.contactId, eligible: false, reason });
      if (reason === "OPTED_OUT") counts.optedOut += 1;
      else if (reason === "NO_CONSENT") counts.noConsent += 1;
      else counts.invalidPhone += 1;
      continue;
    }
    if (analysis.errors.length > 0) continue;

    // Variáveis do contacto prevalecem sobre as manuais.
    const rendered = renderTemplate(input.body, { ...input.manualValues, ...contactVariables(member) });
    if (!rendered.ok) {
      if (rendered.missing.length > 0) {
        missingVariables.push({ contactId: member.contactId, contactName: member.name, missing: rendered.missing });
      } else {
        blockers.push(...rendered.errors);
      }
      continue;
    }
    const segments = getSmsSegmentInfo(rendered.text);
    const max = MAX_UNITS[segments.encoding];
    if (segments.units > max) {
      tooLong.push({ contactId: member.contactId, contactName: member.name, units: segments.units, max });
      continue;
    }
    recipients.push({ contactId: member.contactId, eligible: true, renderedBody: rendered.text, segments });
    counts.eligible += 1;
    counts.totalSegments += segments.segments;
    const country = destinationCountry(member.phoneE164);
    counts.segmentsByCountry[country] = (counts.segmentsByCountry[country] ?? 0) + segments.segments;
  }

  if (missingVariables.length > 0) {
    blockers.push(`${missingVariables.length} contacto(s) elegível(eis) com variáveis em falta.`);
  }
  if (tooLong.length > 0) blockers.push(`${tooLong.length} mensagem(ns) excedem o tamanho máximo de SMS.`);
  if (analysis.errors.length === 0 && counts.eligible === 0 && missingVariables.length === 0 && tooLong.length === 0) {
    blockers.push("Não existem destinatários elegíveis (opt-in e sem opt-out).");
  }
  if (counts.eligible > input.limits.maxRecipients) {
    blockers.push(
      `A campanha tem ${counts.eligible} destinatários elegíveis; o máximo configurado é ${input.limits.maxRecipients}.`,
    );
  }

  return { recipients, counts, missingVariables, tooLong, blockers: [...new Set(blockers)] };
}
