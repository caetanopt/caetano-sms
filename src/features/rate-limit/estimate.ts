import { parsePhoneNumberFromString } from "libphonenumber-js";

/** País de destino (ISO) a partir do E.164; "ZZ" quando não é determinável. */
export function destinationCountry(phoneE164: string): string {
  return parsePhoneNumberFromString(phoneE164)?.country ?? "ZZ";
}

/**
 * Duração mínima estimada de uma campanha com os limites internos (sem contar throttling
 * nem esperas por outros envios): o limite mais apertado entre MPS da origem, MPS de cada
 * país e envios por minuto.
 */
export function estimateMinSendSeconds(input: {
  messages: number;
  segmentsByCountry: Readonly<Record<string, number>>;
  originMps: number;
  countryMps: Readonly<Record<string, number>>;
  defaultCountryMps: number;
  maxPerMinute: number;
}): number {
  const totalParts = Object.values(input.segmentsByCountry).reduce((sum, parts) => sum + parts, 0);
  const perCountry = Object.entries(input.segmentsByCountry).map(
    ([country, parts]) => parts / (input.countryMps[country] ?? input.defaultCountryMps),
  );
  return Math.ceil(Math.max(totalParts / input.originMps, ...perCountry, (input.messages / input.maxPerMinute) * 60, 0));
}

/** "45 s", "12 min", "2 h 5 min" (estimativa para a UI). */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
