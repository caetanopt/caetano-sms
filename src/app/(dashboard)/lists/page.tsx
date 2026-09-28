import Link from "next/link";
import { createListAction } from "@/app/actions/lists";
import { Feedback } from "@/components/feedback";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getListEligibility } from "@/server/services/lists";

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

export default async function ListsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const lists = await prisma.contactList.findMany({ orderBy: { name: "asc" } });
  const eligibility = await Promise.all(lists.map((list) => getListEligibility(list.id)));
  const canWrite = can(user.role, "lists:write");

  return (
    <div>
      <h1 className="text-3xl font-bold">Listas</h1>
      <p className="mt-2 text-slate-600">
        Grupos de contactos. Só os contactos com opt-in e sem opt-out são elegíveis para campanhas.
      </p>
      <Feedback success={params.success} error={params.error} />

      <div className={`mt-6 grid gap-6 ${canWrite ? "lg:grid-cols-[360px_1fr]" : ""}`}>
        {canWrite ? (
          <form action={createListAction} className="space-y-4 self-start rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Nova lista</h2>
            <label className="block text-sm font-medium">Nome
              <input name="name" required maxLength={120} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">Descrição (opcional)
              <textarea name="description" rows={2} maxLength={500} className={inputClass} />
            </label>
            <button className="rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white">Criar lista</button>
          </form>
        ) : null}

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">Contactos</th>
                <th className="px-4 py-3">Elegíveis (opt-in)</th>
                <th className="px-4 py-3">Sem consentimento</th>
                <th className="px-4 py-3">Opt-out</th>
              </tr>
            </thead>
            <tbody>
              {lists.map((list, index) => (
                <tr key={list.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/lists/${list.id}`} className="hover:underline">{list.name}</Link>
                    {list.description ? <div className="text-xs font-normal text-slate-500">{list.description}</div> : null}
                  </td>
                  <td className="px-4 py-3">{eligibility[index].total}</td>
                  <td className="px-4 py-3">{eligibility[index].optedIn}</td>
                  <td className="px-4 py-3">{eligibility[index].withoutConsent}</td>
                  <td className="px-4 py-3">{eligibility[index].optedOut}</td>
                </tr>
              ))}
              {lists.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Ainda não existem listas.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
