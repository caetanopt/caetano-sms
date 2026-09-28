export type SmsMessageType = "TRANSACTIONAL" | "PROMOTIONAL";

export type SendSmsInput = {
  destinationPhoneNumber: string;
  messageBody: string;
  messageType: SmsMessageType;
  dryRun?: boolean;
  /** Metadados não sensíveis. Nunca incluir telefone, nome, email ou texto da mensagem. */
  context?: Record<string, string>;
};

/** Códigos de erro normalizados, independentes do fornecedor. */
export type SmsErrorCode =
  | "VALIDATION_ERROR"
  | "INVALID_PHONE_NUMBER"
  | "OPTED_OUT"
  | "THROTTLED"
  | "SPEND_LIMIT"
  | "QUOTA_EXCEEDED"
  | "PROTECT_BLOCKED"
  | "DESTINATION_NOT_VERIFIED"
  | "AUTH_ERROR"
  | "CONFIGURATION_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export type SmsSendFailure = {
  ok: false;
  errorCode: SmsErrorCode;
  /** Mensagem segura para mostrar ao operador (sem detalhes internos). */
  errorMessage: string;
  /** Seguro repetir: o fornecedor garantidamente não aceitou o pedido. */
  retryable: boolean;
  /**
   * O pedido pode ter sido aceite (ex.: timeout, erro 5xx). Nunca reenviar
   * automaticamente; a mensagem fica em estado UNKNOWN.
   */
  uncertain: boolean;
  providerErrorName?: string;
  providerRequestId?: string;
};

export type SmsSendResult =
  | {
      ok: true;
      messageId: string;
      provider: "aws" | "fake";
    }
  | SmsSendFailure;

export interface SmsProvider {
  send(input: SendSmsInput): Promise<SmsSendResult>;
}
