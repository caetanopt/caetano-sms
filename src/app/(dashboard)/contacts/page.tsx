import Link from "next/link";
import { createContactAction } from "@/app/actions/contacts";
import { ConsentBadge } from "@/components/consent-badge";
import { Feedback } from "@/components/feedback";
import { Pagination } from "@/components/pagination";
import type { Prisma } from "@/generated/prisma/client";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { parsePage } from "@/lib/http/search-params";
import { maskPhoneNumber, normalizePhoneNumber } from "@/lib/phone/normalize";
import { readFlash } from "@/lib/http/flash";

const PAGE_SIZE = 25;
const CONSENT_FILTERS = ["OPTED_IN", "OPTED_OUT", "UNKNOWN"] as const;
type ConsentFilter = (typeof CONSENT_FILTERS)[number];

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

function buildWhere(q: string, consent: ConsentFilter | undefined): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [];
  if (q) {
    const or: Prisma.ContactWhereInput[] = [{ name: { contains: q, mode: "insensitive" } }];
    try {
      or.push({ phoneE164: normalizePhoneNumber(q) });
    } catch {
      const digits = q.replace(/\D/g, "");
      if (digits.length >= 3) or.push({ phoneE164: { contains: digits } });
    }
    and.push({ OR: or });
  }
  if (consent === "OPTED_OUT") and.push({ OR: [{ consentStatus: "OPTED_OUT" }, { optedOutAt: { not: null } }] });
  else if (consent) and.push({ consentStatus: consent, optedOutAt: null });
  return { AND: and };
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string; q?: string; consent?: string; page?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const flash = readFlash(params, "/contacts");
  const q = (params.q ?? "").trim().slice(0, 100);
  const consent = CONSENT_FILTERS.find((value) => value === params.consent);
  const page = parsePage(params.page);
  const where = buildWhere(q, consent);

  const [contacts, total] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        name: true,
        phoneE164: true,
        consentStatus: true,
        optedOutAt: true,
        createdAt: true,
        _count: { select: { lists: true } },
      },
    }),
    prisma.contact.count({ where }),
  ]);

  const canWrite = can(user.role, "contacts:write");
  const hrefFor = (target: number) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (consent) search.set("consent", consent);
    if (target > 1) search.set("page", String(target));
    const query = search.toString();
    return query ? `/contacts?${query}` : "/contacts";
  };

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Contactos</h1>
          <p className="mt-2 text-slate-600">Consentimento e opt-out são sempre explícitos.</p>
        </div>
        {can(user.role, "contacts:import") ? (
          <Link href="/contacts/import" className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50">
            Importar CSV
          </Link>
        ) : null}
      </div>

      <Feedback success={flash.success} error={flash.error} />

      <div className={`mt-6 grid gap-6 ${canWrite ? "lg:grid-cols-[360px_1fr]" : ""}`}>
        {canWrite ? (
          <form action={createContactAction} className="space-y-4 self-start rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Novo contacto</h2>
            <label className="block text-sm font-medium">Nome
              <input name="name" required maxLength={120} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">Telefone
              <input name="phone" required placeholder="912 345 678 ou +351912345678" className={inputClass} />
            </label>
            <label className="block text-sm font-medium">Email (opcional)
              <input name="email" type="email" className={inputClass} />
            </label>
            <label className="block text-sm font-medium">Consentimento
              <select name="consentStatus" defaultValue="UNKNOWN" className={inputClass}>
                <option value="UNKNOWN">Desconhecido</option>
                <option value="OPTED_IN">Opt-in (consentimento documentado)</option>
                <option value="OPTED_OUT">Opt-out</option>
              </select>
            </label>
            <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-xs text-slate-500">Obrigatório para opt-in</legend>
              <label className="block text-sm font-medium">Origem do consentimento
                <input name="consentSource" maxLength={120} placeholder="website, contrato, loja…" className={inputClass} />
              </label>
              <label className="block text-sm font-medium">Finalidade
                <input name="consentPurpose" maxLength={120} placeholder="marketing, notificações de serviço…" className={inputClass} />
              </label>
              <label className="block text-sm font-medium">Texto/versão do consentimento (opcional)
                <input name="consentTextVersion" maxLength={200} placeholder="ex.: política v2 2026-01" className={inputClass} />
              </label>
            </fieldset>
            <button className="rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white">Criar contacto</button>
          </form>
        ) : null}

        <div>
          <form className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4" role="search">
            <label className="block flex-1 text-sm font-medium">Pesquisar
              <input name="q" defaultValue={q} placeholder="Nome ou telefone" className={inputClass} />
            </label>
            <label className="block text-sm font-medium">Consentimento
              <select name="consent" defaultValue={consent ?? ""} className={inputClass}>
                <option value="">Todos</option>
                <option value="OPTED_IN">Opt-in</option>
                <option value="UNKNOWN">Desconhecido</option>
                <option value="OPTED_OUT">Opt-out</option>
              </select>
            </label>
            <button className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold">Filtrar</button>
          </form>

          <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-3">Nome</th>
                  <th className="px-4 py-3">Telefone</th>
                  <th className="px-4 py-3">Consentimento</th>
                  <th className="px-4 py-3">Listas</th>
                  <th className="px-4 py-3">Criado</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-medium">
                      <Link href={`/contacts/${contact.id}`} className="hover:underline">{contact.name}</Link>
                    </td>
                    <td className="px-4 py-3">{maskPhoneNumber(contact.phoneE164)}</td>
                    <td className="px-4 py-3">
                      <ConsentBadge status={contact.consentStatus} optedOut={contact.optedOutAt !== null} />
                    </td>
                    <td className="px-4 py-3">{contact._count.lists}</td>
                    <td className="px-4 py-3 text-slate-500">
                      {contact.createdAt.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" })}
                    </td>
                  </tr>
                ))}
                {contacts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      {q || consent ? "Nenhum contacto corresponde aos filtros." : "Ainda não existem contactos."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} href={hrefFor} />
        </div>
      </div>
    </div>
  );
}
