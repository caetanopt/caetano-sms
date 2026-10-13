import Link from "next/link";
import { notFound } from "next/navigation";
import { addMemberByPhoneAction, deleteListAction, removeMemberAction, updateListAction } from "@/app/actions/lists";
import { ConsentBadge } from "@/components/consent-badge";
import { Feedback } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { parsePage } from "@/lib/http/search-params";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import { getListEligibility } from "@/server/services/lists";
import { readFlash } from "@/lib/http/flash";

const PAGE_SIZE = 50;
const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

export default async function ListDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string; page?: string }>;
}) {
  const user = await requireUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const flash = await readFlash(query, `/lists/${encodeURIComponent(id)}`);
  const page = parsePage(query.page);

  const list = await prisma.contactList.findUnique({ where: { id } });
  if (!list) notFound();

  const [members, eligibility] = await Promise.all([
    prisma.contactListMember.findMany({
      where: { listId: id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { contact: { select: { id: true, name: true, phoneE164: true, consentStatus: true, optedOutAt: true } } },
    }),
    getListEligibility(id),
  ]);
  const canWrite = can(user.role, "lists:write");

  return (
    <div className="max-w-5xl">
      <Link href="/lists" className="text-sm text-slate-600 hover:underline">← Listas</Link>
      <h1 className="mt-2 text-3xl font-bold">{list.name}</h1>
      {list.description ? <p className="mt-1 text-slate-600">{list.description}</p> : null}
      <Feedback success={flash.success} error={flash.error} />

      <dl className="mt-6 grid gap-3 sm:grid-cols-4">
        {([
          ["Contactos", eligibility.total],
          ["Elegíveis (opt-in)", eligibility.optedIn],
          ["Sem consentimento", eligibility.withoutConsent],
          ["Opt-out", eligibility.optedOut],
        ] as const).map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 bg-white p-4">
            <dt className="text-sm text-slate-500">{label}</dt>
            <dd className="mt-1 text-2xl font-bold">{value}</dd>
          </div>
        ))}
      </dl>

      {canWrite ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <form action={addMemberByPhoneAction.bind(null, list.id)} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Adicionar contacto existente</h2>
            <label className="block text-sm font-medium">Telefone
              <input name="phone" required placeholder="912 345 678" className={inputClass} />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Adicionar</button>
              <Link href="/contacts/import" className="text-sm text-slate-600 hover:underline">ou importar CSV para esta lista</Link>
            </div>
          </form>
          <form action={updateListAction.bind(null, list.id)} className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Editar lista</h2>
            <label className="block text-sm font-medium">Nome
              <input name="name" required maxLength={120} defaultValue={list.name} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">Descrição
              <textarea name="description" rows={2} maxLength={500} defaultValue={list.description ?? ""} className={inputClass} />
            </label>
            <button className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold">Guardar</button>
          </form>
        </div>
      ) : null}

      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Telefone</th>
              <th className="px-4 py-3">Consentimento</th>
              <th className="px-4 py-3"><span className="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody>
            {members.map(({ contact }) => (
              <tr key={contact.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/contacts/${contact.id}`} className="hover:underline">{contact.name}</Link>
                </td>
                <td className="px-4 py-3">{maskPhoneNumber(contact.phoneE164)}</td>
                <td className="px-4 py-3">
                  <ConsentBadge status={contact.consentStatus} optedOut={contact.optedOutAt !== null} />
                </td>
                <td className="px-4 py-3 text-right">
                  {canWrite ? (
                    <form action={removeMemberAction.bind(null, list.id, contact.id)}>
                      <button className="text-xs text-red-700 hover:underline">Remover da lista</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
            {members.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">A lista está vazia.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={eligibility.total}
        href={(target) => (target > 1 ? `/lists/${list.id}?page=${target}` : `/lists/${list.id}`)}
      />

      {can(user.role, "lists:delete") ? (
        <section className="mt-6 rounded-xl border border-red-200 bg-white p-5">
          <h2 className="font-semibold text-red-800">Eliminar lista</h2>
          <p className="mt-1 text-sm text-slate-600">Os contactos não são eliminados; apenas deixam de pertencer à lista.</p>
          <form action={deleteListAction.bind(null, list.id)} className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" required /> Confirmo que quero eliminar esta lista
            </label>
            <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white">Eliminar lista</button>
          </form>
        </section>
      ) : null}
    </div>
  );
}
