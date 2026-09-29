import { createHash } from "node:crypto";
import { destinationCountry } from "./estimate";
import type { BucketRule } from "./token-bucket";

/**
 * Limites de partes por segundo (MPS) por identidade de origem e por país (CLAUDE.md §19).
 * Os valores reais dependem da conta, do país e do tipo de origem: configurar com os valores
 * mostrados na consola AWS (ou abaixo deles). Os defeitos são conservadores.
 */
export type SendRateConfig = {
  /** MPS total da identidade de origem. */
  originMps: number;
  /** MPS por país de destino, para a identidade de origem atual. */
  countryMps: Readonly<Record<string, number>>;
  /** MPS para países sem valor explícito. */
  defaultCountryMps: number;
  /** Segundos de rajada: capacidade do balde = MPS × burstSeconds. */
  burstSeconds: number;
};

type Env = Record<string, string | undefined>;

function readRate(raw: string | undefined, key: string, fallback: number) {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0.01 || value > 10_000) {
    throw new Error(`${key} deve ser um número entre 0.01 e 10000`);
  }
  return value;
}

/** `SMS_MPS_BY_COUNTRY=PT=5,ES=1` (códigos ISO 3166-1 alfa-2). */
export function parseCountryMps(raw: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw || raw.trim() === "") return result;
  for (const entry of raw.split(",")) {
    const [country, value, ...rest] = entry.split("=").map((part) => part.trim());
    if (!country || !/^[A-Z]{2}$/.test(country) || value === undefined || rest.length > 0) {
      throw new Error(`SMS_MPS_BY_COUNTRY inválido: "${entry.trim()}" (formato PT=5,ES=1)`);
    }
    result[country] = readRate(value, `SMS_MPS_BY_COUNTRY[${country}]`, 1);
  }
  return result;
}

export function getSendRateConfig(env: Env = process.env): SendRateConfig {
  return {
    originMps: readRate(env.SMS_MPS_PER_ORIGIN, "SMS_MPS_PER_ORIGIN", 1),
    countryMps: parseCountryMps(env.SMS_MPS_BY_COUNTRY),
    defaultCountryMps: readRate(env.SMS_MPS_COUNTRY_DEFAULT, "SMS_MPS_COUNTRY_DEFAULT", 1),
    burstSeconds: readRate(env.SMS_MPS_BURST_SECONDS, "SMS_MPS_BURST_SECONDS", 1),
  };
}

export { destinationCountry };

export type BucketKey = { key: string; rule: BucketRule; label: string };

/**
 * Baldes a consumir para um envio: identidade de origem e (identidade, país).
 * A chave usa um hash da identidade: não guarda ARNs/números na base de dados.
 */
export function bucketsFor(input: { originKey: string; phoneE164: string }, config: SendRateConfig): BucketKey[] {
  const origin = createHash("sha256").update(input.originKey).digest("hex").slice(0, 16);
  const country = destinationCountry(input.phoneE164);
  const countryMps = config.countryMps[country] ?? config.defaultCountryMps;
  const rule = (mps: number): BucketRule => ({ ratePerSecond: mps, capacity: Math.max(1, mps * config.burstSeconds) });
  return [
    { key: `origin:${origin}`, rule: rule(config.originMps), label: "identidade de origem" },
    { key: `origin:${origin}:country:${country}`, rule: rule(countryMps), label: `país ${country}` },
  ];
}
