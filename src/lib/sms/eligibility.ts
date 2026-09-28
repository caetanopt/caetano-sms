import type { SmsMessageType } from "./types";

export type EligibilityContact = {
  consentStatus: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT";
  optedOutAt: Date | null;
};

export type ManualSendEligibility =
  | { ok: true }
  | {
      ok: false;
      reason: "OPTED_OUT" | "NO_CONSENT" | "LEGAL_BASIS_REQUIRED";
      message: string;
    };

export function isOptedOut(contact: EligibilityContact) {
  return contact.optedOutAt !== null || contact.consentStatus === "OPTED_OUT";
}

/**
 * Regras de envio individual:
 * - opt-out bloqueia sempre, qualquer que seja o tipo de mensagem;
 * - promocional para contacto conhecido exige OPTED_IN;
 * - promocional para número desconhecido exige confirmação explícita de base legal.
 */
export function checkManualSendEligibility(input: {
  contact: EligibilityContact | null;
  messageType: SmsMessageType;
  legalBasisConfirmed: boolean;
}): ManualSendEligibility {
  const { contact, messageType, legalBasisConfirmed } = input;

  if (contact && isOptedOut(contact)) {
    return { ok: false, reason: "OPTED_OUT", message: "Este contacto está em opt-out." };
  }

  if (messageType === "PROMOTIONAL") {
    if (contact) {
      if (contact.consentStatus !== "OPTED_IN") {
        return {
          ok: false,
          reason: "NO_CONSENT",
          message: "Envio promocional bloqueado: o contacto não tem opt-in registado.",
        };
      }
    } else if (!legalBasisConfirmed) {
      return {
        ok: false,
        reason: "LEGAL_BASIS_REQUIRED",
        message: "Confirma a base legal/consentimento antes de enviar uma mensagem promocional.",
      };
    }
  }

  return { ok: true };
}
