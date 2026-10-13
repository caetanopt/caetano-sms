/** Política de bloqueio de login (pura). */
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 20;

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export function evaluateLoginThrottle(input: {
  now: Date;
  /** Datas das falhas recentes (dentro da janela), por email e por IP. */
  emailFailures: Date[];
  ipFailures: Date[];
}): ThrottleDecision {
  const check = (failures: Date[], max: number) => {
    if (failures.length < max) return null;
    const oldestRelevant = [...failures].sort((a, b) => b.getTime() - a.getTime())[max - 1];
    return Math.max(1_000, oldestRelevant.getTime() + LOGIN_WINDOW_MS - input.now.getTime());
  };
  const waits = [check(input.emailFailures, MAX_FAILURES_PER_EMAIL), check(input.ipFailures, MAX_FAILURES_PER_IP)].filter(
    (value): value is number => value !== null,
  );
  return waits.length === 0 ? { allowed: true } : { allowed: false, retryAfterMs: Math.max(...waits) };
}

/**
 * IP do cliente. Só se confia em X-Forwarded-For atrás de um proxy conhecido
 * (TRUST_PROXY=true); caso contrário o cabeçalho é falsificável e é ignorado.
 */
export function clientIpFromHeaders(headers: Headers, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || headers.get("x-real-ip")?.trim();
  return candidate && /^[0-9a-fA-F:.]{3,45}$/.test(candidate) ? candidate : null;
}
