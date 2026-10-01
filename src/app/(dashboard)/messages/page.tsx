import Link from "next/link";
import { Pagination } from "@/components/pagination";
import type { Prisma } from "@/generated/prisma/client";
import {
  historyDateRange,
  historyQueryString,
  MESSAGE_STATUSES,
  parseHistoryFilters,
} from "@/features/messages/history-filters";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import { smsStatusLabel } from "@/lib/sms/status-labels";
import { formatLisbon } from "@/lib/time/lisbon";

const PAGE_SIZE = 50;
const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const filters = parseHistoryFilters(await searchParams);
  const range = historyDateRange(filters);

  const where: Prisma.SmsMessageWhereInput = {
    status: filters.status,
    messageType: filters.type,
    campaignId: filters.campaignId,
    createdAt: range.gte || range.lt ? range : undefined,
    contact: filters.q ? { name: { contains: filters.q, mode: "insensitive" } } : undefined,
  };

  const [messages, total, campaigns] = await Promise.all([
    prisma.smsMessage.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        createdBy: { select: { name: true } },
        template: { select: { name: true } },
        contact: { select: { id: true, name: true } },
        campaign: { select: { id: true, name: true } },
      },
    }),
    prisma.smsMessage.count({ where }),
    prisma.campaign.findMany({ orderBy: { createdAt: "desc" }, take: 100, select: { id: true, name: true } }),
  ]);
  // O filtro por campanha mantém-se mesmo para campanhas fora das 100 mais recentes.
  if (filters.campaignId && !campaigns.some((campaign) => campaign.id === filters.campaignId)) {
    const selected = await prisma.campaign.findUnique({ where: { id: filters.campaignId }, select: { id: true, name: true } });
    if (selected) campaigns.unshift(selected);
  }
  const hasFilters = Boolean(filters.status || filters.type || filters.campaignId || filters.from || filters.to || filters.q);

  return (
    <div>
      <h1 className="text-3xl font-bold">Histórico</h1>
      <p className="mt-2 text-slate-600">
        “Aceite pelo fornecedor” não equivale a entregue: a entrega é confirmada pelos eventos da AWS.
      </p>

      <form role="search" className="mt-6 grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-7">
        <label className="block text-sm font-medium lg:col-span-2">Contacto
          <input name="q" defaultValue={filters.q ?? ""} placeholder="Nome do contacto" className={inputClass} />
        </label>
        <label className="block text-sm font-medium">Estado
          <select name="status" defaultValue={filters.status ?? ""} className={inputClass}>
            <option value="">Todos</option>
            {MESSAGE_STATUSES.map((status) => <option key={status} value={status}>{smsStatusLabel(status)}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">Tipo
          <select name="type" defaultValue={filters.type ?? ""} className={inputClass}>
            <option value="">Todos</option>
            <option value="TRANSACTIONAL">Transacional</option>
            <option value="PROMOTIONAL">Promocional</option>
          </select>
        </label>
        <label className="block text-sm font-medium">Campanha
          <select name="campaignId" defaultValue={filters.campaignId ?? ""} className={inputClass}>
            <option value="">Todas</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">De
          <input type="date" name="from" defaultValue={filters.from ?? ""} className={inputClass} />
        </label>
        <label className="block text-sm font-medium">Até
          <input type="date" name="to" defaultValue={filters.to ?? ""} className={inputClass} />
        </label>
        <div className="flex items-end gap-3 lg:col-span-7">
          <button className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold">Filtrar</button>
          {hasFilters ? <Link href="/messages" className="text-sm text-slate-600 hover:underline">Limpar filtros</Link> : null}
          <span className="text-xs text-slate-500">Datas em hora de Lisboa.</span>
        </div>
      </form>

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-3 py-3">Data/hora</th>
              <th className="px-3 py-3">Contacto</th>
              <th className="px-3 py-3">Telefone</th>
              <th className="px-3 py-3">Tipo</th>
              <th className="px-3 py-3">Campanha</th>
              <th className="px-3 py-3">Partes</th>
              <th className="px-3 py-3">Estado</th>
              <th className="px-3 py-3">AWS Message ID</th>
              <th className="px-3 py-3">Operador</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((message) => (
              <tr key={message.id} className="border-t border-slate-100 align-top">
                <td className="px-3 py-3 whitespace-nowrap">{formatLisbon(message.createdAt)}</td>
                <td className="px-3 py-3">
                  {message.contact ? (
                    <Link href={`/contacts/${message.contact.id}`} className="hover:underline">{message.contact.name}</Link>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">{maskPhoneNumber(message.destinationPhoneE164)}</td>
                <td className="px-3 py-3">
                  {message.messageType === "PROMOTIONAL" ? "Promocional" : "Transacional"}
                  {message.template ? <div className="text-xs text-slate-500">{message.template.name}</div> : null}
                </td>
                <td className="px-3 py-3">
                  {message.campaign ? (
                    <Link href={`/campaigns/${message.campaign.id}`} className="hover:underline">{message.campaign.name}</Link>
                  ) : (
                    <span className="text-slate-400">Individual</span>
                  )}
                </td>
                <td className="px-3 py-3">{message.segmentCountEstimate ?? "—"}</td>
                <td className="px-3 py-3">
                  <span className="font-medium">{smsStatusLabel(message.status)}</span>
                  {message.dryRun ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">TESTE</span>
                  ) : null}
                  {message.errorCode ? <div className="text-xs text-red-700">{message.errorCode}</div> : null}
                </td>
                <td className="px-3 py-3 font-mono text-xs">
                  {message.awsMessageId ? (
                    <span title={message.awsMessageId} className="block max-w-[6.5rem] select-all truncate">{message.awsMessageId}</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-3">{message.createdBy.name}</td>
              </tr>
            ))}
            {messages.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                  {hasFilters ? "Nenhuma mensagem corresponde aos filtros." : "Ainda não existem mensagens."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination
        page={filters.page}
        pageSize={PAGE_SIZE}
        total={total}
        href={(page) => `/messages${historyQueryString(filters, page)}`}
      />
    </div>
  );
}
