import Link from "next/link";
import { redirect } from "next/navigation";
import { alertsFor, METRIC_WINDOWS, type MetricWindow } from "@/features/observability/metrics";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { formatLisbon } from "@/lib/time/lisbon";
import { collectOperationalMetrics } from "@/server/services/observability";

export const dynamic = "force-dynamic";

const card = "rounded-xl border border-slate-200 bg-white p-5";
const WINDOW_LABELS: Record<MetricWindow, string> = { "15m": "15 min", "1h": "1 hora", "24h": "24 horas" };
const ms = (value: number | null) => (value === null ? "—" : `${value} ms`);

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className={card}>
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
}

export default async function ObservabilityPage() {
  const user = await requireUser();
  if (!can(user.role, "observability:view")) redirect("/dashboard");

  let metrics;
  try {
    metrics = await collectOperationalMetrics();
  } catch {
    return (
      <div>
        <h1 className="text-3xl font-bold">Observabilidade</h1>
        <div role="alert" className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-800">
          Não foi possível recolher as métricas. Verifica a configuração (fila SQS, variáveis de ambiente).
        </div>
      </div>
    );
  }
  const eventsConfigured = Boolean(process.env.AWS_SMS_EVENTS_SNS_TOPIC_ARN);
  const alerts = alertsFor(metrics, { deliveryEventsConfigured: eventsConfigured });
  const pausedCampaigns = await prisma.campaign.findMany({
    where: { status: { in: ["READY", "SENDING"] }, pausedAt: { not: null }, pausedById: null },
    orderBy: { pausedAt: "desc" },
    take: 10,
    select: { id: true, name: true, lastError: true, pausedAt: true },
  });
  const errors24h = Object.entries(metrics.windows["24h"].errors).sort((a, b) => b[1] - a[1]);
  const windows = Object.keys(METRIC_WINDOWS) as MetricWindow[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Observabilidade</h1>
        <p className="mt-2 text-slate-600">
          Estado operacional dos envios, calculado a partir da base de dados (todas as instâncias). Atualizado em{" "}
          {formatLisbon(metrics.generatedAt)} · modo {metrics.mode === "TEST" ? "TESTE" : "PRODUÇÃO"} · provider {metrics.provider} · fila{" "}
          {metrics.queue.kind === "sqs" ? "SQS" : "direta"}.
        </p>
      </div>

      <section aria-label="Alertas">
        {alerts.length === 0 ? (
          <div role="status" className="rounded-lg bg-emerald-50 p-4 text-sm text-emerald-800">Sem alertas.</div>
        ) : (
          <ul className="space-y-2">
            {alerts.map((alert) => (
              <li
                key={alert.message}
                role="alert"
                className={`rounded-lg p-3 text-sm ${alert.level === "critical" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900"}`}
              >
                <span className="font-semibold">{alert.level === "critical" ? "Crítico" : "Aviso"}:</span> {alert.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card} aria-label="Envios por janela">
        <h2 className="font-semibold">Envios</h2>
        <p className="mt-1 text-xs text-slate-500">
          “Aceites” significa aceite pela AWS (ou pelo modo de teste), não entregue. Latência = duração da chamada ao provider.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-slate-600">
              <tr>
                <th className="py-2 pr-4">Janela</th>
                <th className="py-2 pr-4 text-right">Total</th>
                <th className="py-2 pr-4 text-right">Aceites</th>
                <th className="py-2 pr-4 text-right">Falhados</th>
                <th className="py-2 pr-4 text-right">Incertos</th>
                <th className="py-2 pr-4 text-right">Pendentes</th>
                <th className="py-2 pr-4 text-right">Throttling</th>
                <th className="py-2 pr-4 text-right">Teste</th>
                <th className="py-2 pr-4 text-right">Latência p50</th>
                <th className="py-2 pr-4 text-right">p95</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {windows.map((key) => {
                const w = metrics.windows[key];
                return (
                  <tr key={key} className="border-t border-slate-100">
                    <th scope="row" className="py-2 pr-4 font-medium">{WINDOW_LABELS[key]}</th>
                    <td className="py-2 pr-4 text-right">{w.total}</td>
                    <td className="py-2 pr-4 text-right">{w.byOutcome.accepted}</td>
                    <td className="py-2 pr-4 text-right">{w.byOutcome.failed}</td>
                    <td className="py-2 pr-4 text-right">{w.byOutcome.uncertain}</td>
                    <td className="py-2 pr-4 text-right">{w.byOutcome.pending}</td>
                    <td className="py-2 pr-4 text-right">{w.throttled}</td>
                    <td className="py-2 pr-4 text-right">{w.dryRun}</td>
                    <td className="py-2 pr-4 text-right">{ms(w.latencyMs.p50)}</td>
                    <td className="py-2 pr-4 text-right">{ms(w.latencyMs.p95)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Campanhas a enviar" value={metrics.campaigns.sending} />
        <Stat label="Campanhas pausadas" value={metrics.campaigns.paused} hint={`${metrics.campaigns.pausedWithError} por erro`} />
        <Stat label="Terminadas com falhas (24 h)" value={metrics.campaigns.failedOrPartial24h} hint="FAILED ou PARTIAL" />
        <Stat label="Destinatários presos" value={metrics.recipients.stuckProcessing} hint="em processamento há mais de 5 min" />
        <Stat label="Destinatários incertos" value={metrics.recipients.unknown} hint="UNKNOWN: verificar antes de reenviar" />
        <Stat
          label="Aceites sem recibo (> 24 h)"
          value={eventsConfigured ? metrics.awaitingReceiptOver24h : "—"}
          hint={eventsConfigured ? "envios reais, últimos 7 dias" : "eventos de entrega não configurados"}
        />
        <Stat
          label="Limites MPS"
          value={metrics.rate.bucketsSlowed}
          hint={`baldes abrandados · ${metrics.rate.bucketsThrottled15m} com throttling (15 min)`}
        />
        <Stat
          label="Fila SQS"
          value={metrics.queue.kind === "direct" ? "—" : metrics.queue.up ? metrics.queue.visible : "indisponível"}
          hint={
            metrics.queue.kind === "direct"
              ? "fila direta (sem SQS)"
              : metrics.queue.up
                ? `${metrics.queue.inFlight} em processamento · DLQ ${metrics.queue.dlqVisible ?? "não configurada"}`
                : "sem permissão sqs:GetQueueAttributes ou rede"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className={card} aria-label="Erros nas últimas 24 horas">
          <h2 className="font-semibold">Erros (24 h)</h2>
          {errors24h.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Sem erros.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {errors24h.map(([code, count]) => (
                <li key={code} className="flex justify-between py-2">
                  <span className="font-mono text-xs">{code}</span>
                  <span className="tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={card} aria-label="Campanhas pausadas por erro">
          <h2 className="font-semibold">Campanhas pausadas por erro</h2>
          {pausedCampaigns.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Nenhuma.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {pausedCampaigns.map((campaign) => (
                <li key={campaign.id} className="py-2">
                  <Link href={`/campaigns/${campaign.id}`} className="font-medium hover:underline">{campaign.name}</Link>
                  <div className="text-xs text-slate-500">
                    {campaign.pausedAt ? formatLisbon(campaign.pausedAt) : ""} · {campaign.lastError ?? "—"}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="text-xs text-slate-500">
        Exportação: <code>GET /api/metrics</code> (Prometheus, com <code>METRICS_TOKEN</code>) e snapshot EMF para CloudWatch
        nos workers (<code>METRICS_EMF=true</code>). Ver README.
      </p>
    </div>
  );
}
