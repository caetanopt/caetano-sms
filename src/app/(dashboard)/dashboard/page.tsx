import Link from "next/link";
import { TestModeBanner } from "@/components/test-mode-banner";
import { campaignStatusLabel } from "@/features/campaigns/labels";
import { ConsentStatus } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getSmsRuntimeConfig } from "@/lib/sms/config";
import { formatLisbon, startOfLisbonDay, UI_TIME_ZONE } from "@/lib/time/lisbon";

function lisbonToday() {
  // YYYY-MM-DD em Lisboa.
  return new Intl.DateTimeFormat("en-CA", { timeZone: UI_TIME_ZONE }).format(new Date());
}

export default async function DashboardPage() {
  await requireUser();
  const today = lisbonToday();
  const dayStart = startOfLisbonDay(today)!;
  const monthStart = startOfLisbonDay(`${today.slice(0, 8)}01`)!;

  // Métricas reais excluem envios de teste (dry-run/fake), mostrados à parte.
  const SENT = ["ACCEPTED", "QUEUED", "SENT", "DELIVERED"] as const;
  const real = { dryRun: false };
  const [sentToday, sentMonth, accepted, delivered, failed, pendingUnknown, testMonth, contacts, optedOut, campaigns] = await Promise.all([
    prisma.smsMessage.count({ where: { ...real, status: { in: [...SENT] }, createdAt: { gte: dayStart } } }),
    prisma.smsMessage.count({ where: { ...real, status: { in: [...SENT] }, createdAt: { gte: monthStart } } }),
    prisma.smsMessage.count({ where: { ...real, status: "ACCEPTED", createdAt: { gte: monthStart } } }),
    prisma.smsMessage.count({ where: { ...real, status: "DELIVERED", createdAt: { gte: monthStart } } }),
    prisma.smsMessage.count({
      where: { ...real, status: { in: ["FAILED", "UNROUTABLE", "PROTECT_BLOCKED"] }, createdAt: { gte: monthStart } },
    }),
    prisma.smsMessage.count({ where: { ...real, status: { in: ["PENDING", "UNKNOWN"] }, createdAt: { gte: monthStart } } }),
    prisma.smsMessage.count({ where: { dryRun: true, createdAt: { gte: monthStart } } }),
    prisma.contact.count(),
    prisma.contact.count({
      where: { OR: [{ consentStatus: ConsentStatus.OPTED_OUT }, { optedOutAt: { not: null } }] },
    }),
    prisma.campaign.findMany({
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, name: true, status: true, pausedAt: true, lastError: true, mode: true, updatedAt: true },
    }),
  ]);

  let mode: "TEST" | "PRODUCTION" | null = null;
  let provider = "—";
  try {
    const config = getSmsRuntimeConfig();
    mode = config.mode;
    provider = config.provider;
  } catch {
    mode = null;
  }

  const cards: Array<[string, number, string?]> = [
    ["SMS enviados hoje", sentToday, "Aceites ou posteriores; sem testes"],
    ["SMS enviados no mês", sentMonth, "Aceites ou posteriores; sem testes"],
    ["Aceites pela AWS (mês)", accepted, "Aceite ≠ entregue"],
    ["Entregues (mês)", delivered, "Requer eventos de entrega"],
    ["Falhados (mês)", failed],
    ["Pendentes / incertos (mês)", pendingUnknown],
    ["Envios de teste (mês)", testMonth, "Dry-run / fake: nenhum SMS real"],
    ["Contactos", contacts],
    ["Contactos em opt-out", optedOut],
  ];

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="mt-2 text-slate-600">Visão geral da operação de SMS (mês corrente, hora de Lisboa).</p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">Provider: {provider}</div>
      </div>
      {mode === "TEST" ? <TestModeBanner /> : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, hint]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">{label}</div>
            <div className="mt-2 text-3xl font-bold">{value}</div>
            {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
          </div>
        ))}
      </div>

      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Campanhas recentes</h2>
          <Link href="/campaigns" className="text-sm underline">Ver todas</Link>
        </div>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {campaigns.map((campaign) => (
            <li key={campaign.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link href={`/campaigns/${campaign.id}`} className="font-medium hover:underline">{campaign.name}</Link>
              <span className="text-slate-600">
                {campaignStatusLabel(campaign.status)}
                {campaign.pausedAt && ["READY", "SENDING"].includes(campaign.status) ? " · em pausa" : ""}
                {campaign.mode === "TEST" ? " · TESTE" : ""} · {formatLisbon(campaign.updatedAt)}
              </span>
            </li>
          ))}
          {campaigns.length === 0 ? <li className="py-2 text-slate-500">Ainda não existem campanhas.</li> : null}
        </ul>
      </section>
    </div>
  );
}
