import { requireUser } from "@/lib/auth/session";
import { ConsentStatus, SmsMessageStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";

export default async function DashboardPage() {
  await requireUser();
  const [messages, delivered, failed, contacts, optedOut] = await Promise.all([
    prisma.smsMessage.count(),
    prisma.smsMessage.count({ where: { status: SmsMessageStatus.DELIVERED } }),
    prisma.smsMessage.count({ where: { status: SmsMessageStatus.FAILED } }),
    prisma.contact.count(),
    prisma.contact.count({
      where: {
        OR: [
          { consentStatus: ConsentStatus.OPTED_OUT },
          { optedOutAt: { not: null } },
        ],
      },
    }),
  ]);

  const cards = [
    ["Mensagens", messages],
    ["Entregues", delivered],
    ["Falhadas", failed],
    ["Contactos", contacts],
    ["Opt-out", optedOut],
  ];

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="mt-2 text-slate-600">Visão geral da operação de SMS.</p>
        </div>
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 border border-amber-200">
          Provider: {process.env.SMS_PROVIDER ?? "fake"}
        </div>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">{label}</div>
            <div className="mt-2 text-3xl font-bold">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">Estado do MVP</h2>
        <p className="mt-2 text-sm text-slate-600">
          Inclui autenticação, contactos com histórico de consentimento, suppression list, listas, importação CSV,
          templates, envio individual, histórico, auditoria e providers fake/AWS. Campanhas e delivery receipts
          ficam para as fases seguintes.
        </p>
      </div>
    </div>
  );
}
