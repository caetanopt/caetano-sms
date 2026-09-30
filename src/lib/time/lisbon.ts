/** A UI apresenta datas em Europe/Lisbon; a base de dados guarda UTC (CLAUDE.md §1). */
export const UI_TIME_ZONE = "Europe/Lisbon";

function offsetMinutes(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - instant) / 60_000);
}

/** Início do dia `YYYY-MM-DD` em Lisboa, como instante UTC. null se a data for inválida. */
export function startOfLisbonDay(isoDate: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const guess = Date.UTC(year, month - 1, day);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  let instant = guess - offsetMinutes(guess, UI_TIME_ZONE) * 60_000;
  // Reajustar se o offset mudou entre a estimativa e o resultado (mudança de hora).
  instant = guess - offsetMinutes(instant, UI_TIME_ZONE) * 60_000;
  return new Date(instant);
}

/** Início do dia seguinte (limite exclusivo). */
export function endOfLisbonDay(isoDate: string): Date | null {
  const start = startOfLisbonDay(isoDate);
  if (!start) return null;
  const [year, month, day] = isoDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return startOfLisbonDay(next);
}

/** `YYYY-MM-DD` em Lisboa para o instante dado. */
export function lisbonDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: UI_TIME_ZONE }).format(date);
}

/** Dia civil de Lisboa que contém `now`: início inclusivo e fim exclusivo (= próximo reinício). */
export function lisbonDayWindow(now: Date): { day: string; start: Date; end: Date } {
  const day = lisbonDayKey(now);
  return { day, start: startOfLisbonDay(day)!, end: endOfLisbonDay(day)! };
}

export function formatLisbon(date: Date) {
  return date.toLocaleString("pt-PT", { timeZone: UI_TIME_ZONE });
}
