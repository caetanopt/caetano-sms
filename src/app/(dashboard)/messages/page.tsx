import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import { smsStatusLabel } from "@/lib/sms/status-labels";

export default async function MessagesPage() {
  await requireUser();
  const messages = await prisma.smsMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { createdBy: { select: { name: true } }, template: { select: { name: true } } },
  });

  return (
    <div>
      <h1 className="text-3xl font-bold">Histórico</h1>
      <p className="mt-2 text-slate-600">Aceitação pelo provider não equivale a entrega final.</p>
      <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3">Data</th>
              <th className="px-4 py-3">Destino</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3">Partes</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Operador</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((message) => (
              <tr key={message.id} className="border-t border-slate-100">
                <td className="px-4 py-3">{message.createdAt.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" })}</td>
                <td className="px-4 py-3">{maskPhoneNumber(message.destinationPhoneE164)}</td>
                <td className="px-4 py-3">
                  {message.messageType}
                  {message.template ? <div className="text-xs text-slate-500">{message.template.name}</div> : null}
                </td>
                <td className="px-4 py-3">{message.segmentCountEstimate ?? "-"}</td>
                <td className="px-4 py-3">
                  <span className="font-medium">{smsStatusLabel(message.status)}</span>
                  {message.dryRun ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">TESTE</span>
                  ) : null}
                  {message.errorCode ? <div className="text-xs text-red-700">{message.errorCode}</div> : null}
                </td>
                <td className="px-4 py-3">{message.provider}</td>
                <td className="px-4 py-3">{message.createdBy.name}</td>
              </tr>
            ))}
            {messages.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-500">Ainda não existem mensagens.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
