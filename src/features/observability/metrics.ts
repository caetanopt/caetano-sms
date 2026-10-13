/**
 * Métricas operacionais (CLAUDE.md §32). Código puro: agregação, percentis e formatos de
 * exportação (Prometheus e CloudWatch EMF). Nunca contém números, nomes ou texto de SMS.
 */

export const METRIC_WINDOWS = { "15m": 15 * 60_000, "1h": 60 * 60_000, "24h": 24 * 60 * 60_000 } as const;
export type MetricWindow = keyof typeof METRIC_WINDOWS;

export type Outcome = "accepted" | "failed" | "uncertain" | "pending" | "cancelled";

const OUTCOME_BY_STATUS: Record<string, Outcome> = {
  ACCEPTED: "accepted",
  QUEUED: "accepted",
  SENT: "accepted",
  DELIVERED: "accepted",
  FAILED: "failed",
  UNROUTABLE: "failed",
  PROTECT_BLOCKED: "failed",
  UNKNOWN: "uncertain",
  PENDING: "pending",
  CANCELLED: "cancelled",
};

export function outcomeOf(status: string): Outcome {
  return OUTCOME_BY_STATUS[status] ?? "uncertain";
}

/** Códigos internos conhecidos: outros valores (ex.: eventos da operadora) agregam em OTHER. */
const KNOWN_ERROR_CODES = new Set([
  "VALIDATION_ERROR",
  "INVALID_PHONE_NUMBER",
  "OPTED_OUT",
  "THROTTLED",
  "SPEND_LIMIT",
  "PROTECT_BLOCKED",
  "AUTH_ERROR",
  "PROVIDER_UNAVAILABLE",
  "CONFIGURATION_ERROR",
  "QUOTA_EXCEEDED",
  "UNKNOWN",
]);

export function errorCodeLabel(code: string): string {
  if (KNOWN_ERROR_CODES.has(code)) return code;
  if (/^TEXT_[A-Z_]+$/.test(code)) return "CARRIER_EVENT";
  return "OTHER";
}

export type LatencySummary = { samples: number; p50: number | null; p95: number | null; max: number | null };

/** Percentil pelo método nearest-rank (valores inteiros em ms). */
export function summarizeLatency(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { samples: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { samples: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted[sorted.length - 1] };
}

export type SendWindowMetrics = {
  total: number;
  byOutcome: Record<Outcome, number>;
  /** Envios de teste (dry-run ou fake) incluídos em `total`. */
  dryRun: number;
  throttled: number;
  errors: Record<string, number>;
  latencyMs: LatencySummary;
};

export function emptyWindow(): SendWindowMetrics {
  return {
    total: 0,
    byOutcome: { accepted: 0, failed: 0, uncertain: 0, pending: 0, cancelled: 0 },
    dryRun: 0,
    throttled: 0,
    errors: {},
    latencyMs: summarizeLatency([]),
  };
}

export function aggregateWindow(
  groups: readonly { status: string; errorCode: string | null; dryRun: boolean; count: number }[],
  latencies: readonly number[],
): SendWindowMetrics {
  const window = emptyWindow();
  for (const group of groups) {
    window.total += group.count;
    window.byOutcome[outcomeOf(group.status)] += group.count;
    if (group.dryRun) window.dryRun += group.count;
    if (group.errorCode) {
      const label = errorCodeLabel(group.errorCode);
      window.errors[label] = (window.errors[label] ?? 0) + group.count;
      if (group.errorCode === "THROTTLED") window.throttled += group.count;
    }
  }
  window.latencyMs = summarizeLatency(latencies);
  return window;
}

export type QueueMetrics =
  | { kind: "direct" }
  | { kind: "sqs"; up: false }
  | { kind: "sqs"; up: true; visible: number; inFlight: number; delayed: number; dlqVisible: number | null };

export type OperationalMetrics = {
  generatedAt: Date;
  mode: "TEST" | "PRODUCTION";
  provider: string;
  windows: Record<MetricWindow, SendWindowMetrics>;
  campaigns: { sending: number; paused: number; pausedWithError: number; failedOrPartial24h: number };
  recipients: { stuckProcessing: number; unknown: number };
  /** Aceites pela AWS há mais de 24 h sem recibo final (só relevante com eventos configurados). */
  awaitingReceiptOver24h: number;
  rate: { bucketsThrottled15m: number; bucketsSlowed: number };
  /** Quotas por utilizador (CLAUDE.md §19): esgotadas hoje e campanhas pausadas por quota/conta desativada. */
  quota: { usersExhaustedToday: number; campaignsHaltedByQuota24h: number };
  queue: QueueMetrics;
};

// ---------------------------------------------------------------------------
// Prometheus (text exposition format 0.0.4)
// ---------------------------------------------------------------------------

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

class PromWriter {
  private lines: string[] = [];
  private declared = new Set<string>();

  gauge(name: string, help: string, value: number | null, labels: Record<string, string> = {}) {
    if (!this.declared.has(name)) {
      this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      this.declared.add(name);
    }
    if (value === null) return;
    const entries = Object.entries(labels);
    const rendered = entries.length ? `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}` : "";
    this.lines.push(`${name}${rendered} ${value}`);
  }

  toString() {
    return `${this.lines.join("\n")}\n`;
  }
}

export function toPrometheus(metrics: OperationalMetrics): string {
  const w = new PromWriter();
  w.gauge("sms_app_info", "Configuração atual (1).", 1, { mode: metrics.mode, provider: metrics.provider, queue: metrics.queue.kind });
  for (const [window, data] of Object.entries(metrics.windows)) {
    for (const [outcome, count] of Object.entries(data.byOutcome)) {
      w.gauge("sms_messages_window", "Mensagens criadas na janela, por resultado.", count, { window, outcome });
    }
    w.gauge("sms_messages_dry_run_window", "Mensagens de teste (dry-run/fake) na janela.", data.dryRun, { window });
    w.gauge("sms_throttled_window", "Respostas THROTTLED da AWS na janela.", data.throttled, { window });
    for (const [code, count] of Object.entries(data.errors)) {
      w.gauge("sms_errors_window", "Mensagens com erro na janela, por código normalizado.", count, { window, code });
    }
    w.gauge("sms_provider_latency_ms", "Latência da chamada ao provider (ms).", data.latencyMs.p50, { window, quantile: "0.5" });
    w.gauge("sms_provider_latency_ms", "Latência da chamada ao provider (ms).", data.latencyMs.p95, { window, quantile: "0.95" });
    w.gauge("sms_provider_latency_ms", "Latência da chamada ao provider (ms).", data.latencyMs.max, { window, quantile: "1" });
    w.gauge("sms_provider_latency_samples", "Amostras de latência na janela.", data.latencyMs.samples, { window });
  }
  w.gauge("sms_campaigns", "Campanhas por estado operacional.", metrics.campaigns.sending, { state: "sending" });
  w.gauge("sms_campaigns", "Campanhas por estado operacional.", metrics.campaigns.paused, { state: "paused" });
  w.gauge("sms_campaigns_paused_with_error", "Campanhas pausadas automaticamente com erro.", metrics.campaigns.pausedWithError);
  w.gauge("sms_campaigns_failed_or_partial_24h", "Campanhas terminadas FAILED/PARTIAL nas últimas 24 h.", metrics.campaigns.failedOrPartial24h);
  w.gauge("sms_campaign_recipients_stuck", "Destinatários em PROCESSING há mais do que o limite.", metrics.recipients.stuckProcessing);
  w.gauge("sms_campaign_recipients_unknown", "Destinatários com resultado incerto (UNKNOWN).", metrics.recipients.unknown);
  w.gauge("sms_awaiting_receipt_over_24h", "Aceites há mais de 24 h sem recibo de entrega final.", metrics.awaitingReceiptOver24h);
  w.gauge("sms_rate_buckets_throttled_15m", "Baldes de MPS com THROTTLED nos últimos 15 min.", metrics.rate.bucketsThrottled15m);
  w.gauge("sms_rate_buckets_slowed", "Baldes de MPS com ritmo reduzido após throttling.", metrics.rate.bucketsSlowed);
  w.gauge("sms_quota_users_exhausted_today", "Utilizadores cuja quota diária de partes SMS está esgotada.", metrics.quota.usersExhaustedToday);
  w.gauge(
    "sms_campaigns_halted_by_quota_24h",
    "Campanhas pausadas por quota ou confirmador desativado nas últimas 24 h.",
    metrics.quota.campaignsHaltedByQuota24h,
  );
  if (metrics.queue.kind === "sqs") {
    w.gauge("sms_queue_up", "Leitura dos atributos da fila SQS (1 = OK).", metrics.queue.up ? 1 : 0);
    if (metrics.queue.up) {
      w.gauge("sms_queue_messages", "Mensagens na fila SQS de jobs.", metrics.queue.visible, { queue: "jobs", state: "visible" });
      w.gauge("sms_queue_messages", "Mensagens na fila SQS de jobs.", metrics.queue.inFlight, { queue: "jobs", state: "in_flight" });
      w.gauge("sms_queue_messages", "Mensagens na fila SQS de jobs.", metrics.queue.delayed, { queue: "jobs", state: "delayed" });
      w.gauge("sms_queue_messages", "Mensagens na fila SQS de jobs.", metrics.queue.dlqVisible, { queue: "dlq", state: "visible" });
    }
  }
  return w.toString();
}

// ---------------------------------------------------------------------------
// CloudWatch Embedded Metric Format (uma linha de log JSON → métricas, sem chamadas à AWS)
// ---------------------------------------------------------------------------

export function toEmf(metrics: OperationalMetrics, namespace: string): Record<string, unknown> {
  const w = metrics.windows["15m"];
  const values: Record<string, number> = {
    Accepted15m: w.byOutcome.accepted,
    Failed15m: w.byOutcome.failed,
    Uncertain15m: w.byOutcome.uncertain,
    Throttled15m: w.throttled,
    CampaignsPausedWithError: metrics.campaigns.pausedWithError,
    RecipientsStuck: metrics.recipients.stuckProcessing,
    AwaitingReceiptOver24h: metrics.awaitingReceiptOver24h,
    UsersQuotaExhaustedToday: metrics.quota.usersExhaustedToday,
    CampaignsHaltedByQuota24h: metrics.quota.campaignsHaltedByQuota24h,
  };
  if (w.latencyMs.p95 !== null) values.ProviderLatencyP95Ms = w.latencyMs.p95;
  if (metrics.queue.kind === "sqs" && metrics.queue.up) {
    values.QueueVisible = metrics.queue.visible;
    values.QueueInFlight = metrics.queue.inFlight;
    if (metrics.queue.dlqVisible !== null) values.DlqVisible = metrics.queue.dlqVisible;
  }
  const unit = (name: string) => (name.endsWith("Ms") ? "Milliseconds" : "Count");
  return {
    _aws: {
      Timestamp: metrics.generatedAt.getTime(),
      CloudWatchMetrics: [
        { Namespace: namespace, Dimensions: [["Mode"]], Metrics: Object.keys(values).map((Name) => ({ Name, Unit: unit(Name) })) },
      ],
    },
    event: "metrics.snapshot",
    Mode: metrics.mode,
    ...values,
  };
}

// ---------------------------------------------------------------------------
// Alertas derivados (para a página e para decidir o que monitorizar)
// ---------------------------------------------------------------------------

export type MetricAlert = { level: "warning" | "critical"; message: string };

/** Regras simples e explicáveis; limiares documentados no README. */
export function alertsFor(metrics: OperationalMetrics, options: { deliveryEventsConfigured: boolean }): MetricAlert[] {
  const alerts: MetricAlert[] = [];
  const w15 = metrics.windows["15m"];
  if (metrics.campaigns.pausedWithError > 0) {
    alerts.push({ level: "critical", message: `${metrics.campaigns.pausedWithError} campanha(s) pausada(s) automaticamente por erro.` });
  }
  if (metrics.recipients.stuckProcessing > 0) {
    alerts.push({ level: "warning", message: `${metrics.recipients.stuckProcessing} destinatário(s) presos em processamento (worker parado?).` });
  }
  const errorsBlocking = (w15.errors.AUTH_ERROR ?? 0) + (w15.errors.CONFIGURATION_ERROR ?? 0) + (w15.errors.SPEND_LIMIT ?? 0) + (w15.errors.QUOTA_EXCEEDED ?? 0);
  if (errorsBlocking > 0) {
    alerts.push({ level: "critical", message: "Erros de conta AWS nos últimos 15 min (autenticação, configuração, gastos ou quota)." });
  }
  if (w15.throttled > 0) alerts.push({ level: "warning", message: `${w15.throttled} resposta(s) THROTTLED nos últimos 15 min: rever os limites de MPS.` });
  if (w15.byOutcome.uncertain > 0) {
    alerts.push({ level: "warning", message: `${w15.byOutcome.uncertain} envio(s) com resultado incerto nos últimos 15 min.` });
  }
  const decided = w15.byOutcome.accepted + w15.byOutcome.failed;
  if (decided >= 20 && w15.byOutcome.failed / decided > 0.2) {
    alerts.push({ level: "critical", message: "Mais de 20% de falhas nos últimos 15 min." });
  }
  if (options.deliveryEventsConfigured && metrics.awaitingReceiptOver24h > 0) {
    alerts.push({ level: "warning", message: `${metrics.awaitingReceiptOver24h} mensagem(ns) aceites há mais de 24 h sem recibo de entrega.` });
  }
  if (metrics.quota.usersExhaustedToday > 0) {
    alerts.push({ level: "warning", message: `${metrics.quota.usersExhaustedToday} utilizador(es) com a quota diária de SMS esgotada.` });
  }
  if (metrics.quota.campaignsHaltedByQuota24h > 0) {
    alerts.push({
      level: "warning",
      message: `${metrics.quota.campaignsHaltedByQuota24h} campanha(s) pausada(s) por quota ou conta de quem confirmou desativada nas últimas 24 h (ajustar a quota e retomar; se a conta foi desativada, cancelar e criar uma nova).`,
    });
  }
  if (metrics.queue.kind === "sqs") {
    if (!metrics.queue.up) alerts.push({ level: "critical", message: "Não foi possível ler a fila SQS (permissões ou rede)." });
    else if (metrics.queue.dlqVisible) alerts.push({ level: "critical", message: `${metrics.queue.dlqVisible} mensagem(ns) na DLQ.` });
  }
  return alerts;
}
