/** Política de retenção (CLAUDE.md §13). Valores em dias; configuráveis por ambiente. */
export type RetentionPolicy = {
  /** Texto e número das mensagens são anonimizados após este prazo. */
  smsDays: number;
  /** Eventos de entrega são apagados após este prazo. */
  deliveryEventDays: number;
  /** Tentativas de login (hashes) são apagadas após este prazo. */
  loginAttemptDays: number;
  /** O IP nos registos de auditoria é apagado após este prazo (o registo mantém-se). */
  auditIpDays: number;
};

type Env = Record<string, string | undefined>;

function days(env: Env, key: string, fallback: number, min: number) {
  const raw = env[key];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > 3650) throw new Error(`${key} deve ser um inteiro entre ${min} e 3650`);
  return value;
}

export function getRetentionPolicy(env: Env = process.env): RetentionPolicy {
  return {
    // Mínimo 30 dias: nunca anonimizar mensagens que ainda podem receber eventos de entrega.
    smsDays: days(env, "SMS_RETENTION_DAYS", 365, 30),
    deliveryEventDays: days(env, "DELIVERY_EVENT_RETENTION_DAYS", 365, 30),
    loginAttemptDays: days(env, "LOGIN_ATTEMPT_RETENTION_DAYS", 30, 1),
    auditIpDays: days(env, "AUDIT_IP_RETENTION_DAYS", 90, 1),
  };
}

export function cutoff(now: Date, daysAgo: number) {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60_000);
}
