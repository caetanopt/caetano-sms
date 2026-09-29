import { createHash, createHmac } from "node:crypto";
import { getSmsRuntimeConfig, type SmsRuntimeConfig } from "@/lib/sms/config";

export type CampaignOrigin = {
  config: SmsRuntimeConfig;
  mode: SmsRuntimeConfig["mode"];
  provider: SmsRuntimeConfig["provider"];
  /** sha256 da identidade de origem: deteta alterações sem guardar o valor. */
  originationHash: string;
};

export function currentOrigin(env: Record<string, string | undefined> = process.env): CampaignOrigin {
  const config = getSmsRuntimeConfig(env);
  const identity = config.provider === "fake" ? "fake" : (env.AWS_SMS_ORIGINATION_IDENTITY ?? "");
  return {
    config,
    mode: config.mode,
    provider: config.provider,
    originationHash: createHash("sha256").update(`${config.provider}:${identity}`).digest("hex"),
  };
}

/**
 * HMAC do número revisto (chave AUTH_SECRET): permite detetar alterações sem guardar o
 * número; sem a chave não é possível recuperá-lo por força bruta.
 */
export function phoneHash(phoneE164: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`phone:${phoneE164}`).digest("hex");
}

/** Diferenças entre a origem congelada na confirmação e a atual (mensagens seguras). */
export function originMismatch(
  frozen: { mode: string | null; provider: string | null; originationHash: string | null },
  current: CampaignOrigin,
): string | null {
  if (frozen.mode !== current.mode) {
    return `O modo mudou desde a confirmação (${frozen.mode === "TEST" ? "TESTE" : "PRODUÇÃO"} → ${current.mode === "TEST" ? "TESTE" : "PRODUÇÃO"}). O envio foi parado: cancela a campanha e cria uma nova.`;
  }
  if (frozen.provider !== current.provider || frozen.originationHash !== current.originationHash) {
    return "A identidade de origem ou o fornecedor mudaram desde a confirmação. O envio foi parado: cancela a campanha e cria uma nova.";
  }
  return null;
}
