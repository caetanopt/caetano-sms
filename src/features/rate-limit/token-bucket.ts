/**
 * Token bucket de partes SMS (CLAUDE.md §19). Puro e determinístico: o estado é persistido
 * por quem chama. Unidades: tokens = partes de mensagem; `ratePerSecond` = MPS.
 *
 * - Uma mensagem com mais partes do que a capacidade passa quando o balde está cheio e deixa
 *   o saldo negativo (dívida): as mensagens seguintes esperam o tempo proporcional.
 * - Adaptação a throttling AWS (AIMD): cada THROTTLED esvazia o balde e reduz o ritmo para
 *   metade (mínimo MIN_FACTOR); o ritmo recupera linearmente com o tempo.
 */

export type BucketRule = { ratePerSecond: number; capacity: number };

export type BucketState = {
  tokens: number;
  /** Multiplicador do ritmo (1 = normal; < 1 após throttling). */
  rateFactor: number;
  updatedAt: Date;
};

export const MIN_FACTOR = 0.125;
/** Recuperação do multiplicador por segundo (de 0,5 para 1 em 25 s). */
export const FACTOR_RECOVERY_PER_SECOND = 0.02;

export function initialBucket(rule: BucketRule, now: Date): BucketState {
  return { tokens: rule.capacity, rateFactor: 1, updatedAt: now };
}

/** Estado no instante `now`: recarrega tokens e recupera o multiplicador. */
export function refill(state: BucketState, rule: BucketRule, now: Date): BucketState {
  const elapsed = Math.max(0, (now.getTime() - state.updatedAt.getTime()) / 1000);
  if (elapsed === 0) return state;
  // Integração exata do ritmo enquanto o multiplicador recupera linearmente até 1.
  const recoverySeconds = Math.min(elapsed, (1 - state.rateFactor) / FACTOR_RECOVERY_PER_SECOND);
  const rateFactor = Math.min(1, state.rateFactor + FACTOR_RECOVERY_PER_SECOND * elapsed);
  const recoveringTokens = rule.ratePerSecond * (state.rateFactor * recoverySeconds + (FACTOR_RECOVERY_PER_SECOND * recoverySeconds ** 2) / 2);
  const steadyTokens = rule.ratePerSecond * (elapsed - recoverySeconds);
  return {
    tokens: Math.min(rule.capacity, state.tokens + recoveringTokens + steadyTokens),
    rateFactor,
    updatedAt: now,
  };
}

/** Tokens necessários para poder enviar agora (limitado à capacidade: ver dívida acima). */
function required(cost: number, rule: BucketRule) {
  return Math.min(cost, rule.capacity);
}

/** Milissegundos até haver tokens para `cost`, assumindo o multiplicador atual (conservador). */
export function waitMs(state: BucketState, rule: BucketRule, cost: number): number {
  const missing = required(cost, rule) - state.tokens;
  if (missing <= 0) return 0;
  return Math.ceil((missing / (rule.ratePerSecond * state.rateFactor)) * 1000);
}

export type ConsumeResult = { ok: true; state: BucketState } | { ok: false; state: BucketState; retryAfterMs: number };

export function tryConsume(state: BucketState, rule: BucketRule, cost: number, now: Date): ConsumeResult {
  const current = refill(state, rule, now);
  const wait = waitMs(current, rule, cost);
  if (wait > 0) return { ok: false, state: current, retryAfterMs: wait };
  return { ok: true, state: { ...current, tokens: current.tokens - cost } };
}

/** Resposta THROTTLED da AWS: esvaziar e abrandar. */
export function penalize(state: BucketState, rule: BucketRule, now: Date): BucketState {
  const current = refill(state, rule, now);
  return { tokens: Math.min(0, current.tokens), rateFactor: Math.max(MIN_FACTOR, current.rateFactor / 2), updatedAt: now };
}
