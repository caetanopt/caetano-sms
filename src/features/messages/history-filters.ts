import { endOfLisbonDay, startOfLisbonDay } from "@/lib/time/lisbon";

export const MESSAGE_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "QUEUED",
  "SENT",
  "DELIVERED",
  "FAILED",
  "UNROUTABLE",
  "PROTECT_BLOCKED",
  "UNKNOWN",
  "CANCELLED",
] as const;

export type MessageStatusFilter = (typeof MESSAGE_STATUSES)[number];

export type HistoryFilters = {
  status?: MessageStatusFilter;
  type?: "TRANSACTIONAL" | "PROMOTIONAL";
  campaignId?: string;
  /** YYYY-MM-DD (dia em Lisboa). */
  from?: string;
  to?: string;
  /** Pesquisa por nome do contacto. */
  q?: string;
  page: number;
};

type Raw = Record<string, string | string[] | undefined>;

function one(raw: Raw, key: string) {
  const value = raw[key];
  return typeof value === "string" ? value.trim() : undefined;
}

/** Nunca confia nos parâmetros: tudo o que não é reconhecido é ignorado. */
export function parseHistoryFilters(raw: Raw): HistoryFilters {
  const status = MESSAGE_STATUSES.find((value) => value === one(raw, "status"));
  const typeRaw = one(raw, "type");
  const type = typeRaw === "TRANSACTIONAL" || typeRaw === "PROMOTIONAL" ? typeRaw : undefined;
  const campaignId = one(raw, "campaignId");
  const from = one(raw, "from");
  const to = one(raw, "to");
  const q = one(raw, "q")?.slice(0, 100);
  const page = Number(one(raw, "page"));
  return {
    status,
    type,
    campaignId: campaignId && /^[a-z0-9]{10,40}$/i.test(campaignId) ? campaignId : undefined,
    from: from && startOfLisbonDay(from) ? from : undefined,
    to: to && startOfLisbonDay(to) ? to : undefined,
    q: q || undefined,
    page: Number.isInteger(page) && page > 0 && page < 100_000 ? page : 1,
  };
}

/** Intervalo UTC [gte, lt) correspondente aos dias de Lisboa escolhidos. */
export function historyDateRange(filters: Pick<HistoryFilters, "from" | "to">) {
  return {
    gte: filters.from ? (startOfLisbonDay(filters.from) ?? undefined) : undefined,
    lt: filters.to ? (endOfLisbonDay(filters.to) ?? undefined) : undefined,
  };
}

export function historyQueryString(filters: HistoryFilters, page = filters.page) {
  const params = new URLSearchParams();
  for (const key of ["status", "type", "campaignId", "from", "to", "q"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `?${query}` : "";
}
