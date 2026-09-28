import type { SmsSegmentInfo } from "@/lib/sms/encoding";
import type { SmsMessageType } from "@/lib/sms/types";

export type SendFormValues = {
  phone: string;
  message: string;
  messageType: SmsMessageType | "";
  legalBasis: boolean;
};

export type SendReview = {
  phoneE164: string;
  contactName: string | null;
  consentStatus: "UNKNOWN" | "OPTED_IN" | "OPTED_OUT" | null;
  messageType: SmsMessageType;
  segments: SmsSegmentInfo;
  mode: "TEST" | "PRODUCTION";
  originationLabel: string;
  legalBasisConfirmed: boolean;
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
};

export function initialSendFormState(requestId: string): SendFormState {
  return { step: "edit", requestId, values: emptySendFormValues };
}
