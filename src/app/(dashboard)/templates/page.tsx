import Link from "next/link";
import { Feedback } from "@/components/feedback";
import { checkTemplateBody } from "@/features/templates/template-rules";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

const TYPE_LABELS = { TRANSACTIONAL: "Transacional", PROMOTIONAL: "Promocional" } as const;

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const templates = await prisma.smsTemplate.findMany({
    orderBy: { updatedAt: "desc" },
    include: { createdBy: { select: { name: true } } },
  });

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Templates</h1>
          <p className="mt-2 text-slate-600">
            Mensagens reutilizáveis com variáveis de uma lista fechada. Placeholders por resolver bloqueiam o envio.
          </p>
        </div>
        {can(user.role, "templates:write") ? (
          <Link href="/templates/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Novo template
          </Link>
        ) : null}
      </div>
      <Feedback success={params.success} error={params.error} />

      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3">Variáveis</th>
              <th className="px-4 py-3">Partes (exemplo)</th>
              <th className="px-4 py-3">Atualizado</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((template) => {
              const check = checkTemplateBody(template.body);
              return (
                <tr key={template.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/templates/${template.id}`} className="hover:underline">{template.name}</Link>
                    <div className="max-w-md truncate text-xs font-normal text-slate-500">{template.body}</div>
                  </td>
                  <td className="px-4 py-3">{TYPE_LABELS[template.messageType]}</td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {check.ok ? check.variables.map((v) => `{{${v}}}`).join(" ") || "—" : "inválido"}
                  </td>
                  <td className="px-4 py-3">
                    {check.ok ? `${check.sampleSegments.segments} (${check.sampleSegments.encoding === "GSM_7" ? "GSM-7" : "UCS-2"})` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {template.updatedAt.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" })} · {template.createdBy.name}
                  </td>
                </tr>
              );
            })}
            {templates.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-500">Ainda não existem templates.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
