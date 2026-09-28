import { maskPhoneNumber } from "@/lib/phone/normalize";

export type SmsProviderName = "fake" | "aws";

export type SmsRuntimeConfig = {
  provider: SmsProviderName;
  /** true salvo se AWS_SMS_DRY_RUN for explicitamente "false". */
  dryRun: boolean;
  /** TEST quando nenhum SMS real pode ser enviado. */
  mode: "TEST" | "PRODUCTION";
  /** Identidade de origem mascarada, segura para mostrar na UI. */
  originationLabel: string;
};

type Env = Record<string, string | undefined>;

export class SmsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmsConfigurationError";
  }
}

export function parseProviderName(env: Env = process.env): SmsProviderName {
  const value = env.SMS_PROVIDER ?? "fake";
  if (value === "fake" || value === "aws") return value;
  throw new SmsConfigurationError(`SMS_PROVIDER inválido: ${value}`);
}

/** Falha de forma segura: qualquer valor diferente de "false" mantém o modo de teste. */
export function isDryRun(env: Env = process.env) {
  return env.AWS_SMS_DRY_RUN !== "false";
}

export function maskOriginationIdentity(identity: string | undefined) {
  if (!identity) return "não configurada";
  if (identity.startsWith("+")) return maskPhoneNumber(identity);
  // Sender IDs (até 11 caracteres) são públicos; ARNs e IDs de pool/número são mascarados.
  if (identity.length <= 11) return identity;
  return `${identity.slice(0, 4)}…${identity.slice(-4)}`;
}

export function getSmsRuntimeConfig(env: Env = process.env): SmsRuntimeConfig {
  const provider = parseProviderName(env);
  const dryRun = isDryRun(env);
  return {
    provider,
    dryRun,
    mode: provider === "fake" || dryRun ? "TEST" : "PRODUCTION",
    originationLabel:
      provider === "fake"
        ? "fake (simulado)"
        : maskOriginationIdentity(env.AWS_SMS_ORIGINATION_IDENTITY),
  };
}
