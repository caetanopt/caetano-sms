/** Limites internos de segurança para campanhas (CLAUDE.md §8.6, §19, §29). */
export type CampaignLimits = {
  /** Máximo de destinatários elegíveis por campanha. */
  maxRecipients: number;
  /** Envios por minuto (global: campanhas + envio individual). */
  maxSendsPerMinute: number;
  /** Mensagens processadas por passo (request curto). */
  batchSize: number;
  /** Acima deste número de destinatários é pedida a confirmação textual "ENVIAR N SMS". */
  bulkConfirmationThreshold: number;
  /** Tentativas por destinatário (só para falhas garantidamente não enviadas, ex.: throttling). */
  maxAttempts: number;
};

type Env = Record<string, string | undefined>;

function readInt(env: Env, key: string, fallback: number, min: number, max: number) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

export function getCampaignLimits(env: Env = process.env): CampaignLimits {
  return {
    maxRecipients: readInt(env, "SMS_MAX_RECIPIENTS_PER_CAMPAIGN", 500, 1, 100_000),
    maxSendsPerMinute: readInt(env, "SMS_MAX_SENDS_PER_MINUTE", 60, 1, 10_000),
    batchSize: readInt(env, "SMS_CAMPAIGN_BATCH_SIZE", 10, 1, 100),
    bulkConfirmationThreshold: readInt(env, "SMS_BULK_CONFIRMATION_THRESHOLD", 50, 1, 100_000),
    maxAttempts: readInt(env, "SMS_CAMPAIGN_MAX_ATTEMPTS", 3, 1, 10),
  };
}
