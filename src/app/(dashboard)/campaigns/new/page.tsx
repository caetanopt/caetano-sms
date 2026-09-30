import Link from "next/link";
import { CampaignEditor } from "@/components/campaigns/campaign-editor";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { loadEditorData } from "../editor-data";

export default async function NewCampaignPage() {
  const user = await requireUser();
  const allowed = can(user.role, "campaigns:write");
  const data = allowed ? await loadEditorData() : null;
  return (
    <div className="max-w-4xl">
      <Link href="/campaigns" className="text-sm text-slate-600 hover:underline">← Campanhas</Link>
      <h1 className="mt-2 text-3xl font-bold">Nova campanha</h1>
      {data ? (
        data.lists.length === 0 ? (
          <p className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
            Cria primeiro uma <Link href="/lists" className="underline">lista de contactos</Link>.
          </p>
        ) : (
          <CampaignEditor lists={data.lists} templates={data.templates} globalMaxPerMinute={data.globalMaxPerMinute} />
        )
      ) : (
        <p className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          O teu perfil não permite criar campanhas.
        </p>
      )}
    </div>
  );
}
