import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteTemplateAction } from "@/app/actions/templates";
import { Feedback } from "@/components/feedback";
import { TemplateEditor } from "@/components/templates/template-editor";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { readFlash } from "@/lib/http/flash";

export default async function TemplateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  const [{ id }, feedback] = await Promise.all([params, searchParams]);
  const flash = readFlash(feedback);
  const template = await prisma.smsTemplate.findUnique({
    where: { id },
    include: { createdBy: { select: { name: true } }, _count: { select: { messages: true } } },
  });
  if (!template) notFound();
  const canWrite = can(user.role, "templates:write");

  return (
    <div className="max-w-6xl">
      <Link href="/templates" className="text-sm text-slate-600 hover:underline">← Templates</Link>
      <h1 className="mt-2 text-3xl font-bold">{template.name}</h1>
      <p className="mt-1 text-sm text-slate-600">
        Criado por {template.createdBy.name} · usado em {template._count.messages} mensagem(ns)
      </p>
      <Feedback success={flash.success} error={flash.error} />

      {canWrite ? (
        <>
          {/* key: remonta o editor com os valores guardados após cada gravação */}
          <TemplateEditor
            key={template.updatedAt.toISOString()}
            template={{ id: template.id, name: template.name, body: template.body, messageType: template.messageType }}
          />
          <section className="mt-6 rounded-xl border border-red-200 bg-white p-5">
            <h2 className="font-semibold text-red-800">Eliminar template</h2>
            <p className="mt-1 text-sm text-slate-600">As mensagens já enviadas mantêm o texto; apenas perdem a ligação ao template.</p>
            <form action={deleteTemplateAction.bind(null, template.id)} className="mt-3 flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="confirm" required /> Confirmo que quero eliminar este template
              </label>
              <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white">Eliminar</button>
            </form>
          </section>
        </>
      ) : (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-500">{template.messageType === "PROMOTIONAL" ? "Promocional" : "Transacional"}</p>
          <p className="mt-2 whitespace-pre-wrap font-mono text-sm">{template.body}</p>
        </div>
      )}
    </div>
  );
}
