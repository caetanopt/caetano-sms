export const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Rascunho",
  READY: "Confirmada",
  SENDING: "Em envio",
  COMPLETED: "Concluída",
  PARTIAL: "Concluída com falhas",
  CANCELLED: "Cancelada",
  FAILED: "Falhada",
};

export const RECIPIENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Por enviar",
  PROCESSING: "Em envio",
  ACCEPTED: "Aceite pelo fornecedor",
  FAILED: "Falhou",
  UNKNOWN: "Resultado incerto",
  SKIPPED: "Excluído",
  CANCELLED: "Cancelado",
};

export const SKIP_REASON_LABELS: Record<string, string> = {
  OPTED_OUT: "Opt-out",
  NO_CONSENT: "Sem consentimento (opt-in)",
  INVALID_PHONE: "Número inválido",
  CONTACT_DELETED: "Contacto eliminado",
  PHONE_CHANGED: "Número alterado após a confirmação",
};

export function campaignStatusLabel(status: string) {
  return CAMPAIGN_STATUS_LABELS[status] ?? status;
}
