import Link from "next/link";
import { Feedback } from "@/components/feedback";
import { TestModeBanner } from "@/components/test-mode-banner";
import { campaignStatusLabel } from "@/features/campaigns/labels";
import { ConsentStatus } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getSmsRuntimeConfig } from "@/lib/sms/config";
import { formatLisbon, lisbonDayKey, startOfLisbonDay } from "@/lib/time/lisbon";
import { readFlash } from "@/lib/http/flash";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  const feedback = await searchParams;
  const flash = readFlash(feedback, "/dashboard");
  const today = lisbonDayKey(new Date());
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

  // Custo real (§43): o maior preço reportado por mensagem nos eventos AWS do mês.
  const prices = await prisma.smsDeliveryEvent.groupBy({
    by: ["smsMessageId"],
    where: { smsMessageId: { not: null }, priceUsd: { not: null }, createdAt: { gte: monthStart } },
    _max: { priceUsd: true },
  });
  const realCostUsd = prices.reduce((sum, row) => sum + Number(row._max.priceUsd ?? 0), 0);
  const eventsConfigured = Boolean(process.env.AWS_SMS_EVENTS_SNS_TOPIC_ARN);

  let mode: "TEST" | "PRODUCTION" | null = null;
  let provider = "—";
  try {
    const config = getSmsRuntimeConfig();
    mode = config.mode;
    provider = config.provider;
  } catch {
    mode = null;
  }

  // Acento por categoria (cores secundárias da marca, §04.1).
  const ACCENT: Record<string, string> = {
    "SMS enviados hoje": "from-brand-cyan to-brand-cyan-60",
    "SMS enviados no mês": "from-brand-deep to-brand-deep-60",
    "Aceites pela AWS (mês)": "from-brand-cyan to-brand-deep-80",
    "Entregues (mês)": "from-brand-eco to-emerald-200",
    "Falhados (mês)": "from-red-500 to-red-300",
    "Pendentes / incertos (mês)": "from-brand-orange to-amber-200",
    "Envios de teste (mês)": "from-brand-yellow to-amber-100",
    Contactos: "from-brand-deep-80 to-brand-deep-20",
    "Contactos em opt-out": "from-brand-grey to-slate-200",
  };
  const hour = Number(new Intl.DateTimeFormat("pt-PT", { timeZone: "Europe/Lisbon", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  const greeting = hour < 12 ? "Bom dia" : hour < 20 ? "Boa tarde" : "Boa noite";

  const cards: Array<[string, number, string?]> = [
    ["SMS enviados hoje", sentToday, "Aceites ou posteriores; sem testes"],
    ["SMS enviados no mês", sentMonth, "Aceites ou posteriores; sem testes"],
    ["Aceites pela AWS (mês)", accepted, "Aceite ≠ entregue"],
    ["Entregues (mês)", delivered, eventsConfigured ? "Confirmado por eventos da AWS" : "Eventos de entrega não configurados"],
    ["Falhados (mês)", failed],
    ["Pendentes / incertos (mês)", pendingUnknown],
    ["Envios de teste (mês)", testMonth, "Dry-run / fake: nenhum SMS real"],
    ["Contactos", contacts],
    ["Contactos em opt-out", optedOut],
  ];

  return (
    <div>
      <div className="relative overflow-hidden rounded-3xl bg-brand-deep px-8 py-9 text-white shadow-[0_30px_60px_-30px_rgb(0_46_93/0.7)]">
        <div aria-hidden="true" className="absolute -right-16 -top-24 h-72 w-72 rounded-full bg-brand-cyan/30 blur-3xl animate-float" />
        <div aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(115deg,transparent_40%,rgb(0_174_239/0.18)_70%,transparent_90%)]" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm font-medium text-brand-cyan-60">{greeting}, {user.name.split(" ")[0]}</p>
            <h1 className="mt-1 text-3xl font-bold text-white sm:text-4xl">Dashboard</h1>
            <p className="mt-2 max-w-xl text-white/70">Visão geral da operação de SMS (mês corrente, hora de Lisboa).</p>
          </div>
          <div className="rounded-xl bg-white/10 px-4 py-2.5 text-sm text-white/85 ring-1 ring-white/15 backdrop-blur">Provider: {provider}</div>
        </div>
      </div>
      <Feedback success={flash.success} error={flash.error} />
      {mode === "TEST" ? <TestModeBanner /> : null}
      {!eventsConfigured ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
          Eventos de entrega ainda não configurados: <strong>ACEITE PELA AWS</strong> não significa{" "}
          <strong>ENTREGUE</strong>. Ver “Eventos de entrega” no README.
        </div>
      ) : null}

      <div className="stagger mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...cards, ["Custo real (mês, USD)", realCostUsd, "Reportado nos eventos AWS; sem eventos = 0"] as [string, number, string]].map(([label, value, hint]) => (
          <div key={label} className="card-lift relative overflow-hidden rounded-xl border border-slate-200 bg-white p-5">
            <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${ACCENT[label] ?? "from-brand-cyan to-brand-deep"}`} />
            <div className="text-sm font-medium text-slate-500">{label}</div>
            <div className="mt-2 text-3xl font-bold tabular-nums text-brand-deep">
              {label.startsWith("Custo") ? value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : value}
            </div>
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
