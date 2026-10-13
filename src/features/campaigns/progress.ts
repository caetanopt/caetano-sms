import type { RecipientStatusCounts } from "./processing-rules";

/** DTO devolvido ao browser pelo passo de processamento e pelo polling de progresso. */
export type CampaignProgress = {
  state: "progress" | "wait" | "busy" | "paused" | "finished" | "forbidden" | "error";
  status: string;
  counts: RecipientStatusCounts;
  lastError: string | null;
  paused: boolean;
  retryAfterMs: number;
  message?: string;
};

export const ACTIVE_CAMPAIGN_STATUSES = ["READY", "SENDING"] as const;
