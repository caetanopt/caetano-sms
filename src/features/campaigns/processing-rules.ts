/**
 * Regras puras do processamento de campanhas (CLAUDE.md §17-§19).
 */

export type RecipientStatusCounts = {
  PENDING: number;
  PROCESSING: number;
  ACCEPTED: number;
  FAILED: number;
  UNKNOWN: number;
  SKIPPED: number;
  CANCELLED: number;
};

export const EMPTY_RECIPIENT_COUNTS: RecipientStatusCounts = {
  PENDING: 0,
  PROCESSING: 0,
  ACCEPTED: 0,
  FAILED: 0,
  UNKNOWN: 0,
  SKIPPED: 0,
  CANCELLED: 0,
};

/**
 * Backoff exponencial com jitter para falhas garantidamente não enviadas
 * (ex.: throttling). `random` injetável para testes.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random) {
  const base = 5_000 * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, 5 * 60_000);
  const jitter = 0.7 + random() * 0.6; // ±30%
  return Math.round(capped * jitter);
}

/**
 * Estado final quando já não há destinatários por processar.
 * - COMPLETED: ≥1 aceite e nenhuma falha/incerto (SKIPPED/CANCELLED não contam);
 * - PARTIAL: há aceites e falhas/incertos;
 * - FAILED: nenhum aceite (inclui "todos deixaram de ser elegíveis no momento do envio").
 */
export function finalCampaignStatus(counts: RecipientStatusCounts): "COMPLETED" | "PARTIAL" | "FAILED" | null {
  if (counts.PENDING > 0 || counts.PROCESSING > 0) return null;
  // Nada aceite (tudo falhou, incerto ou deixou de ser elegível no envio) nunca é "concluída".
  if (counts.ACCEPTED === 0) return "FAILED";
  return counts.FAILED + counts.UNKNOWN === 0 ? "COMPLETED" : "PARTIAL";
}

/** Chave de idempotência de uma tentativa de envio de campanha (única por destinatário e tentativa). */
export function campaignIdempotencyKey(campaignId: string, recipientId: string, attempt: number) {
  return `campaign:${campaignId}:${recipientId}:${attempt}`;
}
