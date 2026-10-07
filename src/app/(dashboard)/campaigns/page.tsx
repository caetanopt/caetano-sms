import Link from "next/link";
import { Feedback } from "@/components/feedback";
import { campaignStatusLabel } from "@/features/campaigns/labels";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { formatLisbon } from "@/lib/time/lisbon";
import { readFlash } from "@/lib/http/flash";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const flash = readFlash(params, "/campaigns");
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      list: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });
  const counts = await prisma.campaignRecipient.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaigns.map((campaign) => campaign.id) } },
    _count: { _all: true },
  });
  const countFor = (campaignId: string, status: string) =>
    counts.find((row) => row.campaignId === campaignId && row.status === status)?._count._all ?? 0;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">Campanhas</h1>
          <p className="mt-2 text-slate-600">
            Envio para listas: só contactos com opt-in e sem opt-out; confirmação explícita antes de enviar.
          </p>
        </div>
        {can(user.role, "campaigns:write") ? (
          <Link href="/campaigns/new" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
            Nova campanha
          </Link>
        ) : null}
      </div>
      <Feedback success={flash.success} error={flash.error} />

      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3">Lista</th>
              <th className="px-4 py-3">Aceites / a enviar</th>
              <th className="px-4 py-3">Criada</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => {
              const accepted = countFor(campaign.id, "ACCEPTED");
              const toSend = ["PENDING", "PROCESSING", "ACCEPTED", "FAILED", "UNKNOWN"].reduce(
                (sum, status) => sum + countFor(campaign.id, status),
                0,
              );
              return (
                <tr key={campaign.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 font-medium">
                    <Link href={`/campaigns/${campaign.id}`} className="hover:underline">{campaign.name}</Link>
                  </td>
                  <td className="px-4 py-3">
                    {campaignStatusLabel(campaign.status)}
                    {campaign.pausedAt && ["READY", "SENDING"].includes(campaign.status) ? (
                      <div className="text-xs text-amber-800">Em pausa{campaign.lastError ? `: ${campaign.lastError}` : ""}</div>
                    ) : null}
                    {campaign.mode === "TEST" ? (
                      <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">TESTE</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{campaign.messageType === "PROMOTIONAL" ? "Promocional" : "Transacional"}</td>
                  <td className="px-4 py-3">{campaign.list?.name ?? "—"}</td>
                  <td className="px-4 py-3">{campaign.status === "DRAFT" ? "—" : `${accepted} / ${toSend}`}</td>
                  <td className="px-4 py-3 text-slate-500">
                    {formatLisbon(campaign.createdAt)} · {campaign.createdBy.name}
                  </td>
                </tr>
              );
            })}
            {campaigns.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-500">Ainda não existem campanhas.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
