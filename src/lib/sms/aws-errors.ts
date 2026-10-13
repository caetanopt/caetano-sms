import type { SmsErrorCode, SmsSendFailure } from "./types";

type Classification = {
  errorCode: SmsErrorCode;
  errorMessage: string;
  retryable: boolean;
  uncertain: boolean;
};

const MESSAGES: Record<SmsErrorCode, string> = {
  VALIDATION_ERROR: "A AWS rejeitou o pedido por dados inválidos.",
  INVALID_PHONE_NUMBER: "A AWS rejeitou o número de destino.",
  OPTED_OUT: "O destinatário está em opt-out na AWS. Não foi enviado.",
  THROTTLED: "A AWS aplicou throttling. Não foi enviado; tenta novamente mais tarde.",
  SPEND_LIMIT: "Limite de gastos de SMS da conta AWS atingido. Não foi enviado.",
  QUOTA_EXCEEDED: "Quota da conta AWS atingida. Não foi enviado.",
  PROTECT_BLOCKED: "Envio bloqueado pela Protect Configuration ou país de destino não permitido.",
  DESTINATION_NOT_VERIFIED:
    "A conta AWS está em sandbox e este número de destino não está verificado.",
  AUTH_ERROR: "Falha de autenticação/autorização com a AWS. Contacta um administrador.",
  CONFIGURATION_ERROR:
    "Configuração AWS inválida (origem, Configuration Set ou país). Contacta um administrador.",
  PROVIDER_UNAVAILABLE: "A AWS não está disponível neste momento.",
  UNKNOWN: "Erro inesperado ao comunicar com a AWS.",
};

function classify(
  errorCode: SmsErrorCode,
  options: { retryable?: boolean; uncertain?: boolean; message?: string } = {},
): Classification {
  return {
    errorCode,
    errorMessage: options.message ?? MESSAGES[errorCode],
    retryable: options.retryable ?? false,
    uncertain: options.uncertain ?? false,
  };
}

const VALIDATION_REASONS: Record<string, SmsErrorCode> = {
  DESTINATION_COUNTRY_BLOCKED: "PROTECT_BLOCKED",
  PRICE_OVER_THRESHOLD: "SPEND_LIMIT",
  CHANNEL_NOT_ENABLED: "CONFIGURATION_ERROR",
  COUNTRY_NOT_ENABLED: "CONFIGURATION_ERROR",
  COUNTRY_CODE_MISMATCH: "CONFIGURATION_ERROR",
  INTERNATIONAL_SENDING_NOT_SUPPORTED: "CONFIGURATION_ERROR",
  INVALID_IDENTITY_FOR_DESTINATION_COUNTRY: "CONFIGURATION_ERROR",
  SENDER_ID_NOT_REGISTERED: "CONFIGURATION_ERROR",
  SENDER_ID_NOT_SUPPORTED: "CONFIGURATION_ERROR",
  SENDER_ID_REQUIRES_REGISTRATION: "CONFIGURATION_ERROR",
  INVALID_ARN: "CONFIGURATION_ERROR",
  RESOURCE_NOT_ACCESSIBLE: "CONFIGURATION_ERROR",
};

const CONFLICT_REASONS: Record<string, SmsErrorCode> = {
  DESTINATION_PHONE_NUMBER_OPTED_OUT: "OPTED_OUT",
  DESTINATION_COUNTRY_BLOCKED_BY_PROTECT_CONFIGURATION: "PROTECT_BLOCKED",
  DESTINATION_PHONE_NUMBER_BLOCKED_BY_PROTECT_NUMBER_OVERRIDE: "PROTECT_BLOCKED",
  DESTINATION_PHONE_NUMBER_NOT_VERIFIED: "DESTINATION_NOT_VERIFIED",
};

const AUTH_ERROR_NAMES = new Set([
  "CredentialsProviderError",
  "ExpiredTokenException",
  "ExpiredToken",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "InvalidClientTokenId",
  "SignatureDoesNotMatch",
  "MissingAuthenticationToken",
]);

/** Falhas de rede em que o pedido garantidamente não chegou à AWS. */
const NOT_SENT_NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

type AwsLikeError = {
  name?: unknown;
  code?: unknown;
  Reason?: unknown;
  Fields?: unknown;
  $metadata?: { requestId?: unknown; httpStatusCode?: unknown };
  $retryable?: unknown;
};

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function isPhoneFieldError(fields: unknown) {
  return (
    Array.isArray(fields) &&
    fields.some(
      (field) =>
        typeof field === "object" &&
        field !== null &&
        (field as { Name?: unknown }).Name === "DestinationPhoneNumber",
    )
  );
}

function classifyAwsError(error: AwsLikeError, name: string): Classification {
  const reason = asString(error.Reason);

  switch (name) {
    case "ThrottlingException":
      return classify("THROTTLED", { retryable: true });
    case "ValidationException":
      if (reason && VALIDATION_REASONS[reason]) return classify(VALIDATION_REASONS[reason]);
      if (isPhoneFieldError(error.Fields)) return classify("INVALID_PHONE_NUMBER");
      return classify("VALIDATION_ERROR");
    case "ConflictException":
      return classify((reason && CONFLICT_REASONS[reason]) || "CONFIGURATION_ERROR");
    case "ServiceQuotaExceededException":
      return classify(reason?.startsWith("MONTHLY_SPEND_LIMIT") ? "SPEND_LIMIT" : "QUOTA_EXCEEDED");
    case "AccessDeniedException":
      return classify("AUTH_ERROR");
    case "ResourceNotFoundException":
      return classify("CONFIGURATION_ERROR");
    case "InternalServerException":
      // Um 5xx não garante que a mensagem não foi aceite.
      return classify("PROVIDER_UNAVAILABLE", { uncertain: true });
  }

  if (AUTH_ERROR_NAMES.has(name)) return classify("AUTH_ERROR");

  const code = asString(error.code);
  if (code && NOT_SENT_NETWORK_CODES.has(code)) {
    return classify("PROVIDER_UNAVAILABLE", { retryable: true });
  }

  // Timeouts, ligações cortadas, erros desconhecidos: o resultado é incerto.
  return classify("UNKNOWN", { uncertain: true });
}

/**
 * Traduz um erro lançado pelo AWS SDK para um resultado normalizado.
 * Nunca devolve stack traces, mensagens do SDK ou dados de credenciais.
 */
export function mapAwsSmsError(error: unknown): SmsSendFailure {
  const awsError = (typeof error === "object" && error !== null ? error : {}) as AwsLikeError;
  const name = asString(awsError.name) ?? "UnknownError";
  const classification = classifyAwsError(awsError, name);

  return {
    ok: false,
    ...classification,
    providerErrorName: name,
    providerRequestId: asString(awsError.$metadata?.requestId),
  };
}
