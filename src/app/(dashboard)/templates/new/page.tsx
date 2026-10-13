import Link from "next/link";
import { TemplateEditor } from "@/components/templates/template-editor";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";

export default async function NewTemplatePage() {
  const user = await requireUser();
  return (
    <div className="max-w-6xl">
      <Link href="/templates" className="text-sm text-slate-600 hover:underline">← Templates</Link>
      <h1 className="mt-2 text-3xl font-bold">Novo template</h1>
      {can(user.role, "templates:write") ? (
        <TemplateEditor />
      ) : (
        <p className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          O teu perfil não permite criar templates.
        </p>
      )}
    </div>
  );
}
