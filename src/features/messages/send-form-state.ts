import type { SmsSegmentInfo } from "@/lib/sms/encoding";
import type { TemplateValues } from "@/lib/sms/templates";
import type { SmsMessageType } from "@/lib/sms/types";

export type SendFormValues = {
  phone: string;
  message: string;
  messageType: SmsMessageType | "";
  legalBasis: boolean;
  /** "" = texto livre. */
  templateId: string;
  /** Apenas variáveis manuais (date, time, place). */
  variables: TemplateValues;
};

export type SendReview = {
  phoneE164: string;
  contactName: string | null;
  consentStatus: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT" | null;
  messageType: SmsMessageType;
  segments: SmsSegmentInfo;
  renderedMessage: string;
  templateName: string | null;
  mode: "TEST" | "PRODUCTION";
  originationLabel: string;
  legalBasisConfirmed: boolean;
  /** Quota diária de partes SMS do operador (informativa; a verificação final é feita ao confirmar). */
  quota: { used: number; limit: number; remaining: number; afterSend: number; committed: number } | null;
};

export type SendResult = {
  kind: "accepted" | "duplicate" | "failed" | "uncertain";
  message: string;
};

export type SendFormState = {
  step: "edit" | "review" | "done";
  /** Chave de idempotência: mantém-se entre revisão e confirmação. */
  requestId: string;
  values: SendFormValues;
  error?: string;
  review?: SendReview;
  result?: SendResult;
};

export const emptySendFormValues: SendFormValues = {
  phone: "",
  message: "",
  messageType: "",
  legalBasis: false,
  templateId: "",
  variables: {},
};

export function initialSendFormState(requestId: string): SendFormState {
  return { step: "edit", requestId, values: emptySendFormValues };
}
