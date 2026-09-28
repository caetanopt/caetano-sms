import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber } from "@/lib/phone/normalize";

export default async function MessagesPage() {
  await requireUser();
  const messages = await prisma.smsMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { createdBy: { select: { name: true } } },
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
                <td className="px-4 py-3">{message.messageType}</td>
                <td className="px-4 py-3">{message.segmentCountEstimate ?? "-"}</td>
                <td className="px-4 py-3 font-medium">{message.status}</td>
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
