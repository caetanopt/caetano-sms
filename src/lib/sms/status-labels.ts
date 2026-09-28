/** Rótulos PT-PT. ACCEPTED significa aceite pelo fornecedor, nunca entregue. */
export const SMS_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendente",
  ACCEPTED: "Aceite pelo fornecedor",
  QUEUED: "Em fila",
  SENT: "Enviado ao operador",
  DELIVERED: "Entregue",
  FAILED: "Falhou",
  UNROUTABLE: "Sem rota",
  PROTECT_BLOCKED: "Bloqueado (Protect)",
  UNKNOWN: "Resultado incerto",
  CANCELLED: "Cancelado",
};

export function smsStatusLabel(status: string) {
  return SMS_STATUS_LABELS[status] ?? status;
}
