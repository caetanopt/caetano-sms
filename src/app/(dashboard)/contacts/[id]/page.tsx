import Link from "next/link";
import { notFound } from "next/navigation";
import { changeConsentAction, deleteContactAction, updateContactAction } from "@/app/actions/contacts";
import { addContactToListAction, removeMemberAction } from "@/app/actions/lists";
import { ConsentBadge } from "@/components/consent-badge";
import { Feedback } from "@/components/feedback";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import { smsStatusLabel } from "@/lib/sms/status-labels";

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";
const card = "rounded-xl border border-slate-200 bg-white p-5";
const formatDate = (date: Date) => date.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });

const PROCESS_LABELS: Record<string, string> = {
  manual: "Manual",
  "csv-import": "Importação CSV",
  provider: "Fornecedor (AWS)",
};

export default async function ContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  const [{ id }, feedback] = await Promise.all([params, searchParams]);

  const contact = await prisma.contact.findUnique({
    where: { id },
    include: {
      consentEvents: { orderBy: { createdAt: "desc" }, take: 50, include: { recordedBy: { select: { name: true } } } },
      lists: { include: { list: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
      messages: { orderBy: { createdAt: "desc" }, take: 5, select: { id: true, createdAt: true, status: true, messageType: true, dryRun: true } },
    },
  });
  if (!contact) notFound();

  const [suppression, allLists] = await Promise.all([
    prisma.suppressionEntry.findUnique({ where: { phoneE164: contact.phoneE164 } }),
    prisma.contactList.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  const canWrite = can(user.role, "contacts:write");
  const optedOut = contact.optedOutAt !== null || contact.consentStatus === "OPTED_OUT" || suppression !== null;
  const canOptIn = canWrite && (!optedOut || can(user.role, "contacts:reopt-in"));
  const memberListIds = new Set(contact.lists.map((member) => member.listId));
  const availableLists = allLists.filter((list) => !memberListIds.has(list.id));

  return (
    <div className="max-w-5xl">
      <Link href="/contacts" className="text-sm text-slate-600 hover:underline">← Contactos</Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-bold">{contact.name}</h1>
        <ConsentBadge status={contact.consentStatus} optedOut={optedOut} />
      </div>
      <p className="mt-1 text-slate-600">
        {canWrite ? contact.phoneE164 : maskPhoneNumber(contact.phoneE164)} · criado em {formatDate(contact.createdAt)}
      </p>

      <Feedback success={feedback.success} error={feedback.error} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className={card}>
          <h2 className="font-semibold">Dados</h2>
          {canWrite ? (
            <form action={updateContactAction.bind(null, contact.id)} className="mt-3 space-y-3">
              <label className="block text-sm font-medium">Nome
                <input name="name" required maxLength={120} defaultValue={contact.name} className={inputClass} />
              </label>
              <label className="block text-sm font-medium">Email
                <input name="email" type="email" defaultValue={contact.email ?? ""} className={inputClass} />
              </label>
              <label className="block text-sm font-medium">Notas
                <textarea name="notes" rows={3} maxLength={1000} defaultValue={contact.notes ?? ""} className={inputClass} />
              </label>
              <p className="text-xs text-slate-500">O número não é editável: para outro número cria um contacto novo.</p>
              <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Guardar</button>
            </form>
          ) : (
            <dl className="mt-3 space-y-1 text-sm">
              <div><dt className="inline text-slate-500">Email: </dt><dd className="inline">{contact.email ?? "—"}</dd></div>
              <div><dt className="inline text-slate-500">Notas: </dt><dd className="inline">{contact.notes ?? "—"}</dd></div>
            </dl>
          )}
        </section>

        <section className={card}>
          <h2 className="font-semibold">Consentimento</h2>
          <dl className="mt-3 space-y-1 text-sm">
            <div><dt className="inline text-slate-500">Estado: </dt><dd className="inline font-medium">{optedOut ? "Opt-out" : contact.consentStatus === "OPTED_IN" ? "Opt-in" : "Desconhecido"}</dd></div>
            <div><dt className="inline text-slate-500">Origem: </dt><dd className="inline">{contact.consentSource ?? "—"}</dd></div>
            <div><dt className="inline text-slate-500">Opt-in em: </dt><dd className="inline">{contact.consentAt ? formatDate(contact.consentAt) : "—"}</dd></div>
            <div><dt className="inline text-slate-500">Opt-out em: </dt><dd className="inline">{contact.optedOutAt ? formatDate(contact.optedOutAt) : "—"}</dd></div>
            <div><dt className="inline text-slate-500">Suppression list: </dt><dd className="inline">{suppression ? `sim (desde ${formatDate(suppression.createdAt)})` : "não"}</dd></div>
          </dl>

          {canWrite && !optedOut ? (
            <form action={changeConsentAction.bind(null, contact.id)} className="mt-4 space-y-2 rounded-lg border border-red-200 p-3">
              <input type="hidden" name="to" value="OPTED_OUT" />
              <label className="block text-sm font-medium">Motivo/origem do opt-out
                <input name="consentSource" maxLength={120} placeholder="pedido do cliente, STOP…" className={inputClass} />
              </label>
              <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white">Registar opt-out</button>
            </form>
          ) : null}

          {canOptIn ? (
            <details className="mt-4 rounded-lg border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-semibold">
                {optedOut ? "Registar novo opt-in (administrador)" : "Registar opt-in"}
              </summary>
              <form action={changeConsentAction.bind(null, contact.id)} className="mt-3 space-y-2">
                <input type="hidden" name="to" value="OPTED_IN" />
                {optedOut ? (
                  <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">
                    Este número está em opt-out. Só registes um novo opt-in se existir consentimento explícito e
                    documentado posterior ao opt-out. O número sai da suppression list local; a AWS pode manter o seu
                    próprio opt-out.
                  </p>
                ) : null}
                <label className="block text-sm font-medium">Origem *
                  <input name="consentSource" required maxLength={120} placeholder="website, loja, contrato…" className={inputClass} />
                </label>
                <label className="block text-sm font-medium">Finalidade *
                  <input name="consentPurpose" required maxLength={120} placeholder="marketing, notificações…" className={inputClass} />
                </label>
                <label className="block text-sm font-medium">Texto/versão (opcional)
                  <input name="consentTextVersion" maxLength={200} className={inputClass} />
                </label>
                <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Registar opt-in</button>
              </form>
            </details>
          ) : null}
        </section>
      </div>

      <section className={`${card} mt-6`}>
        <h2 className="font-semibold">Histórico de consentimento</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2">Data</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Origem</th>
                <th className="px-3 py-2">Finalidade</th>
                <th className="px-3 py-2">Versão</th>
                <th className="px-3 py-2">Registado por</th>
              </tr>
            </thead>
            <tbody>
              {contact.consentEvents.map((event) => (
                <tr key={event.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{formatDate(event.createdAt)}</td>
                  <td className="px-3 py-2"><ConsentBadge status={event.status} /></td>
                  <td className="px-3 py-2">{event.source}</td>
                  <td className="px-3 py-2">{event.purpose ?? "—"}</td>
                  <td className="px-3 py-2">{event.textVersion ?? "—"}</td>
                  <td className="px-3 py-2">
                    {PROCESS_LABELS[event.process] ?? event.process}
                    {event.recordedBy ? ` · ${event.recordedBy.name}` : ""}
                  </td>
                </tr>
              ))}
              {contact.consentEvents.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Sem registos de consentimento.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className={card}>
          <h2 className="font-semibold">Listas</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {contact.lists.map((member) => (
              <li key={member.listId} className="flex items-center justify-between gap-3">
                <Link href={`/lists/${member.list.id}`} className="hover:underline">{member.list.name}</Link>
                {can(user.role, "lists:write") ? (
                  <form action={removeMemberAction.bind(null, member.listId, contact.id)}>
                    <input type="hidden" name="back" value="contact" />
                    <button className="text-xs text-red-700 hover:underline">Remover</button>
                  </form>
                ) : null}
              </li>
            ))}
            {contact.lists.length === 0 ? <li className="text-slate-500">Não pertence a nenhuma lista.</li> : null}
          </ul>
          {can(user.role, "lists:write") && availableLists.length > 0 ? (
            <form action={addContactToListAction.bind(null, contact.id)} className="mt-4 flex gap-2">
              <select name="listId" aria-label="Lista" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm">
                {availableLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
              </select>
              <button className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold">Adicionar</button>
            </form>
          ) : null}
        </section>

        <section className={card}>
          <h2 className="font-semibold">Mensagens recentes</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {contact.messages.map((message) => (
              <li key={message.id}>
                {formatDate(message.createdAt)} · {message.messageType} · {smsStatusLabel(message.status)}
                {message.dryRun ? " · TESTE" : ""}
              </li>
            ))}
            {contact.messages.length === 0 ? <li className="text-slate-500">Sem mensagens.</li> : null}
          </ul>
        </section>
      </div>

      {can(user.role, "contacts:delete") ? (
        <section className="mt-6 rounded-xl border border-red-200 bg-white p-5">
          <h2 className="font-semibold text-red-800">Eliminar contacto</h2>
          <p className="mt-1 text-sm text-slate-600">
            Remove os dados do contacto, o histórico de consentimento e as associações a listas. O histórico de mensagens
            mantém-se sem ligação ao contacto. Se o número estiver na suppression list, continua bloqueado.
          </p>
          <form action={deleteContactAction.bind(null, contact.id)} className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" required /> Confirmo que quero eliminar este contacto
            </label>
            <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white">Eliminar</button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
