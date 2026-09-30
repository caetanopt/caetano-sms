import { describe, expect, it } from "vitest";
import {
  aggregateWindow,
  alertsFor,
  emptyWindow,
  errorCodeLabel,
  summarizeLatency,
  toEmf,
  toPrometheus,
  type OperationalMetrics,
} from "@/features/observability/metrics";
import { bearerMatches, getMetricsConfig } from "@/lib/observability/config";

function snapshot(overrides: Partial<OperationalMetrics> = {}): OperationalMetrics {
  return {
    generatedAt: new Date("2026-09-29T10:00:00Z"),
    mode: "TEST",
    provider: "fake",
    windows: { "15m": emptyWindow(), "1h": emptyWindow(), "24h": emptyWindow() },
    campaigns: { sending: 0, paused: 0, pausedWithError: 0, failedOrPartial24h: 0 },
    recipients: { stuckProcessing: 0, unknown: 0 },
    awaitingReceiptOver24h: 0,
    rate: { bucketsThrottled15m: 0, bucketsSlowed: 0 },
    quota: { usersExhaustedToday: 0, campaignsHaltedByQuota24h: 0 },
    queue: { kind: "direct" },
    ...overrides,
  };
}

describe("summarizeLatency", () => {
  it("computes nearest-rank percentiles", () => {
    expect(summarizeLatency([])).toEqual({ samples: 0, p50: null, p95: null, max: null });
    expect(summarizeLatency([40])).toEqual({ samples: 1, p50: 40, p95: 40, max: 40 });
    const values = Array.from({ length: 100 }, (_, i) => 100 - i); // 1..100 desordenado
    expect(summarizeLatency(values)).toEqual({ samples: 100, p50: 50, p95: 95, max: 100 });
  });
});

describe("aggregateWindow", () => {
  it("maps statuses to outcomes, counts throttling, test sends and normalized error codes", () => {
    const window = aggregateWindow(
      [
        { status: "ACCEPTED", errorCode: null, dryRun: true, count: 5 },
        { status: "DELIVERED", errorCode: null, dryRun: false, count: 2 },
        { status: "FAILED", errorCode: "THROTTLED", dryRun: false, count: 3 },
        { status: "FAILED", errorCode: "TEXT_CARRIER_UNREACHABLE", dryRun: false, count: 1 },
        { status: "UNKNOWN", errorCode: "UNKNOWN", dryRun: false, count: 1 },
        { status: "PENDING", errorCode: null, dryRun: false, count: 1 },
        { status: "FAILED", errorCode: "weird value", dryRun: false, count: 1 },
      ],
      [10, 20, 30],
    );
    expect(window).toMatchObject({
      total: 14,
      dryRun: 5,
      throttled: 3,
      byOutcome: { accepted: 7, failed: 5, uncertain: 1, pending: 1, cancelled: 0 },
      errors: { THROTTLED: 3, CARRIER_EVENT: 1, UNKNOWN: 1, OTHER: 1 },
      latencyMs: { samples: 3, p50: 20, p95: 30, max: 30 },
    });
    expect(errorCodeLabel("AUTH_ERROR")).toBe("AUTH_ERROR");
  });
});

describe("toPrometheus", () => {
  it("renders the text format with HELP/TYPE once per metric and skips null values", () => {
    const windows = { "15m": aggregateWindow([{ status: "ACCEPTED", errorCode: null, dryRun: false, count: 2 }], [12]), "1h": emptyWindow(), "24h": emptyWindow() };
    const text = toPrometheus(snapshot({ windows, queue: { kind: "sqs", up: true, visible: 4, inFlight: 1, delayed: 0, dlqVisible: null } }));
    expect(text).toContain('sms_app_info{mode="TEST",provider="fake",queue="sqs"} 1');
    expect(text).toContain('sms_messages_window{window="15m",outcome="accepted"} 2');
    expect(text).toContain('sms_provider_latency_ms{window="15m",quantile="0.95"} 12');
    expect(text).not.toContain('sms_provider_latency_ms{window="1h"');
    expect(text).toContain('sms_queue_messages{queue="jobs",state="visible"} 4');
    expect(text).not.toContain('queue="dlq"');
    expect(text.match(/# TYPE sms_messages_window gauge/g)).toHaveLength(1);
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.trim().split("\n")) {
      expect(line).toMatch(/^(# (HELP|TYPE) [a-z0-9_]+ .+|[a-z0-9_]+(\{[^}]*\})? -?\d+(\.\d+)?)$/);
    }
  });

  it("escapes label values", () => {
    const text = toPrometheus(snapshot({ provider: 'a"b\\c' }));
    expect(text).toContain('provider="a\\"b\\\\c"');
  });

  it("reports a queue that could not be read", () => {
    expect(toPrometheus(snapshot({ queue: { kind: "sqs", up: false } }))).toContain("sms_queue_up 0");
  });
});

describe("toEmf", () => {
  it("builds a CloudWatch Embedded Metric Format document", () => {
    const doc = toEmf(snapshot({ queue: { kind: "sqs", up: true, visible: 3, inFlight: 0, delayed: 0, dlqVisible: 1 } }), "SmsApp");
    expect(doc).toMatchObject({ _aws: { Timestamp: Date.parse("2026-09-29T10:00:00Z") }, Mode: "TEST", QueueVisible: 3, DlqVisible: 1 });
    const definition = (doc._aws as { CloudWatchMetrics: { Namespace: string; Metrics: { Name: string }[] }[] }).CloudWatchMetrics[0];
    expect(definition.Namespace).toBe("SmsApp");
    for (const { Name } of definition.Metrics) expect(doc).toHaveProperty(Name);
    expect(doc).not.toHaveProperty("ProviderLatencyP95Ms");
  });
});

describe("alertsFor", () => {
  it("is quiet when everything is fine", () => {
    expect(alertsFor(snapshot(), { deliveryEventsConfigured: true })).toEqual([]);
  });

  it("flags circuit breakers, account errors, failure rate, stuck work, DLQ and missing receipts", () => {
    const w = aggregateWindow(
      [
        { status: "ACCEPTED", errorCode: null, dryRun: false, count: 15 },
        { status: "FAILED", errorCode: "AUTH_ERROR", dryRun: false, count: 5 },
        { status: "FAILED", errorCode: "THROTTLED", dryRun: false, count: 2 },
      ],
      [],
    );
    const alerts = alertsFor(
      snapshot({
        windows: { "15m": w, "1h": w, "24h": w },
        campaigns: { sending: 0, paused: 1, pausedWithError: 1, failedOrPartial24h: 0 },
        recipients: { stuckProcessing: 2, unknown: 0 },
        awaitingReceiptOver24h: 3,
        queue: { kind: "sqs", up: true, visible: 0, inFlight: 0, delayed: 0, dlqVisible: 4 },
      }),
      { deliveryEventsConfigured: true },
    );
    const text = alerts.map((a) => a.message).join("\n");
    expect(text).toMatch(/pausada/);
    expect(text).toMatch(/Erros de conta/);
    expect(text).toMatch(/20% de falhas/);
    expect(text).toMatch(/presos/);
    expect(text).toMatch(/THROTTLED/);
    expect(text).toMatch(/DLQ/);
    expect(text).toMatch(/sem recibo/);
    expect(alerts.filter((a) => a.level === "critical").length).toBeGreaterThanOrEqual(3);
    // Sem eventos configurados, a ausência de recibo não é um alerta.
    expect(alertsFor(snapshot({ awaitingReceiptOver24h: 3 }), { deliveryEventsConfigured: false })).toEqual([]);
  });
});

describe("metrics config", () => {
  it("disables the endpoint without a token and validates settings", () => {
    expect(getMetricsConfig({})).toEqual({ token: null, emf: { enabled: false, intervalMs: 60_000, namespace: "SmsApp" } });
    expect(() => getMetricsConfig({ METRICS_TOKEN: "short" })).toThrow(/32/);
    expect(() => getMetricsConfig({ METRICS_EMF_NAMESPACE: "bad namespace" })).toThrow(/NAMESPACE/);
    expect(() => getMetricsConfig({ METRICS_EMF_INTERVAL_SECONDS: "5" })).toThrow(/INTERVAL/);
    expect(getMetricsConfig({ METRICS_EMF: "true", METRICS_EMF_INTERVAL_SECONDS: "30" }).emf).toMatchObject({ enabled: true, intervalMs: 30_000 });
  });

  it("matches only the exact bearer token", () => {
    const token = "t".repeat(40);
    expect(bearerMatches(`Bearer ${token}`, token)).toBe(true);
    expect(bearerMatches(`Bearer ${token}x`, token)).toBe(false);
    expect(bearerMatches(token, token)).toBe(false);
    expect(bearerMatches(null, token)).toBe(false);
  });
});
