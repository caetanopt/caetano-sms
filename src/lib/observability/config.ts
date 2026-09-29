import { createHash, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export class MetricsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsConfigurationError";
  }
}

export type MetricsConfig = {
  /** Token Bearer de `GET /api/metrics`; null = endpoint desativado (404). */
  token: string | null;
  emf: { enabled: boolean; intervalMs: number; namespace: string };
};

export function getMetricsConfig(env: Env = process.env): MetricsConfig {
  const token = env.METRICS_TOKEN ?? "";
  if (token !== "" && token.length < 32) throw new MetricsConfigurationError("METRICS_TOKEN deve ter pelo menos 32 caracteres");

  const namespace = env.METRICS_EMF_NAMESPACE || "SmsApp";
  if (!/^[A-Za-z0-9/_.#:-]{1,255}$/.test(namespace)) throw new MetricsConfigurationError("METRICS_EMF_NAMESPACE inválido");
  const rawInterval = env.METRICS_EMF_INTERVAL_SECONDS ?? "";
  const interval = rawInterval === "" ? 60 : Number(rawInterval);
  if (!Number.isInteger(interval) || interval < 10 || interval > 3600) {
    throw new MetricsConfigurationError("METRICS_EMF_INTERVAL_SECONDS deve ser um inteiro entre 10 e 3600");
  }
  return {
    token: token === "" ? null : token,
    emf: { enabled: env.METRICS_EMF === "true", intervalMs: interval * 1000, namespace },
  };
}

/** Comparação em tempo constante (hash para igualar comprimentos). */
export function bearerMatches(header: string | null, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}
