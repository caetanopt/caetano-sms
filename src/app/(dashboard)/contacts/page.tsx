import { createContactAction } from "@/app/actions/contacts";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import { prisma } from "@/lib/db/prisma";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const [params, contacts] = await Promise.all([
    searchParams,
    prisma.contact.findMany({ orderBy: { createdAt: "desc" }, take: 50 }),
  ]);

  return (
    <div>
      <h1 className="text-3xl font-bold">Contactos</h1>
      <p className="mt-2 text-slate-600">Consentimento e opt-out são sempre explícitos.</p>

      {params.success ? <div className="mt-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{params.success}</div> : null}
      {params.error ? <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">{params.error}</div> : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[360px_1fr]">
        <form action={createContactAction} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold">Novo contacto</h2>
          <label className="block text-sm font-medium">Nome
            <input name="name" required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="block text-sm font-medium">Telefone
            <input name="phone" required placeholder="+351912345678" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <label className="block text-sm font-medium">Consentimento
            <select name="consentStatus" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
              <option value="UNKNOWN">Desconhecido</option>
              <option value="OPTED_IN">Opt-in</option>
              <option value="OPTED_OUT">Opt-out</option>
            </select>
          </label>
          <label className="block text-sm font-medium">Origem do consentimento
            <input name="consentSource" placeholder="website, contrato, loja..." className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <button className="rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white">Criar contacto</button>
        </form>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-3">Nome</th>
                <th className="px-4 py-3">Telefone</th>
                <th className="px-4 py-3">Consentimento</th>
                <th className="px-4 py-3">Criado</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr key={contact.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 font-medium">{contact.name}</td>
                  <td className="px-4 py-3">{maskPhoneNumber(contact.phoneE164)}</td>
                  <td className="px-4 py-3">{contact.consentStatus}</td>
                  <td className="px-4 py-3 text-slate-500">{contact.createdAt.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" })}</td>
                </tr>
              ))}
              {contacts.length === 0 ? (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-slate-500">Ainda não existem contactos.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
