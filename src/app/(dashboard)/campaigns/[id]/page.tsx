import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteCampaignDraftAction } from "@/app/actions/campaigns";
import { CampaignEditor } from "@/components/campaigns/campaign-editor";
import { CampaignRunner } from "@/components/campaigns/campaign-runner";
import { ConfirmForm } from "@/components/campaigns/confirm-form";
import { Feedback } from "@/components/feedback";
import { TestModeBanner } from "@/components/test-mode-banner";
import { estimateMinSendSeconds, formatDuration } from "@/features/rate-limit/estimate";
import { getSendRateConfig } from "@/features/rate-limit/rules";
import { describeQuota } from "@/features/rate-limit/quota";
import { campaignStatusLabel, RECIPIENT_STATUS_LABELS, SKIP_REASON_LABELS } from "@/features/campaigns/labels";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber } from "@/lib/phone/normalize";
import { getSmsRuntimeConfig } from "@/lib/sms/config";
import { describeMissing, TEMPLATE_VARIABLES } from "@/lib/sms/templates";
import { formatLisbon } from "@/lib/time/lisbon";
import { reconcileCampaign, recipientCounts } from "@/server/services/campaigns/engine";
import { campaignVariables, buildCampaignPreview } from "@/server/services/campaigns/preview";
import { loadEditorData } from "../editor-data";
import { readFlash } from "@/lib/http/flash";

const card = "rounded-xl border border-slate-200 bg-white p-6";
const PREVIEW_ROWS = 100;

function Summary({ rows }: { rows: Array<[string, string | number]> }) {
  return (
    <dl className="divide-y divide-slate-100 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[240px_1fr] gap-4 py-2">
          <dt className="text-slate-500">{label}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  const [{ id }, feedback] = await Promise.all([params, searchParams]);
  const flash = await readFlash(feedback, `/campaigns/${encodeURIComponent(id)}`);
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      confirmedBy: { select: { name: true } },
      createdBy: { select: { name: true } },
      list: { select: { name: true } },
      template: { select: { name: true } },
    },
  });
  if (!campaign) notFound();

  const canWrite = can(user.role, "campaigns:write");
  const canSend = can(user.role, "campaigns:send");
  const typeLabel = campaign.messageType === "PROMOTIONAL" ? "PROMOTIONAL (promocional)" : "TRANSACTIONAL (transacional)";

  const header = (
    <>
      <Link href="/campaigns" className="text-sm text-slate-600 hover:underline">← Campanhas</Link>
      <h1 className="mt-2 text-3xl font-bold">{campaign.name}</h1>
      <p className="mt-1 text-sm text-slate-600">
        {campaignStatusLabel(campaign.status)} · criada por {campaign.createdBy.name} em {formatLisbon(campaign.createdAt)}
      </p>
      <Feedback success={flash.success} error={flash.error} />
    </>
  );

  // ------------------------------------------------------------------ rascunho
  if (campaign.status === "DRAFT") {
    const [preview, editorData] = await Promise.all([
      buildCampaignPreview(campaign.id, canSend ? { userId: user.id } : undefined),
      canWrite ? loadEditorData() : Promise.resolve(null),
    ]);
    if (!preview) notFound();
    const { plan } = preview;
    const testMode = preview.origin.mode === "TEST";
    const eligibleRows = plan.recipients.filter((r) => r.eligible).slice(0, PREVIEW_ROWS);
    const excludedRows = plan.recipients.filter((r) => !r.eligible).slice(0, PREVIEW_ROWS);
    const example = plan.recipients.find((r) => r.eligible);
    const rate = getSendRateConfig();
    const minDuration = `${formatDuration(
      estimateMinSendSeconds({
        messages: plan.counts.eligible,
        segmentsByCountry: plan.counts.segmentsByCountry,
        originMps: rate.originMps,
        countryMps: rate.countryMps,
        defaultCountryMps: rate.defaultCountryMps,
        maxPerMinute: preview.pace.effective,
      }),
    )} (estimativa pelos limites internos)`;

    return (
      <div className="max-w-5xl space-y-6">
        <div>{header}</div>
        {testMode ? <TestModeBanner /> : null}

        {editorData ? (
          <CampaignEditor
            key={campaign.updatedAt.toISOString()}
            campaign={{
              id: campaign.id,
              name: campaign.name,
              listId: campaign.listId,
              templateId: campaign.templateId,
              messageBody: campaign.messageBody,
              messageType: campaign.messageType,
              variables: campaignVariables(campaign.variablesJson),
              maxSendsPerMinute: campaign.maxSendsPerMinute,
            }}
            lists={editorData.lists}
            templates={editorData.templates}
            globalMaxPerMinute={editorData.globalMaxPerMinute}
          />
        ) : null}

        <section className={card} aria-label="Resumo antes do envio">
          <h2 className="text-lg font-semibold">Rever antes de enviar</h2>
          <div className="mt-3">
            <Summary
              rows={[
                ["Campanha", campaign.name],
                ["Tipo", typeLabel],
                ["Lista", preview.campaign.listName ?? "—"],
                ["Template", preview.campaign.templateName ?? "Texto livre"],
                ["Destinatários elegíveis", plan.counts.eligible],
                ["Excluídos por opt-out", plan.counts.optedOut],
                ["Sem consentimento", plan.counts.noConsent],
                ["Números inválidos", plan.counts.invalidPhone],
                ["Partes SMS estimadas", plan.counts.totalSegments],
                ["Origem", preview.origin.config.originationLabel],
                [
                  "Ritmo máximo",
                  preview.pace.campaign !== null
                    ? `${preview.pace.effective} mensagens/minuto (definido nesta campanha; global ${preview.pace.global})`
                    : `${preview.pace.global} mensagens/minuto (limite global)`,
                ],
                ...(preview.quota
                  ? [
                      [
                        "Quota diária de quem confirma",
                        describeQuota(preview.quota) +
                          (preview.quota.committedElsewhere.parts > 0
                            ? ` · ${preview.quota.committedElsewhere.parts} reservadas noutras campanhas tuas`
                            : ""),
                      ] as [string, string],
                    ]
                  : []),
                ["Duração mínima estimada", minDuration],
                ["Modo", testMode ? "TESTE" : "PRODUÇÃO"],
              ]}
            />
          </div>

          {plan.blockers.length > 0 ? (
            <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p className="font-semibold">Não é possível confirmar:</p>
              <ul className="mt-1 list-disc pl-5">
                {plan.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            </div>
          ) : null}

          {plan.missingVariables.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Contactos com variáveis em falta</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {plan.missingVariables.slice(0, PREVIEW_ROWS).map((row) => (
                  <li key={row.contactId}>
                    <Link href={`/contacts/${row.contactId}`} className="underline">{row.contactName}</Link>: falta{" "}
                    {describeMissing(row.missing)}
                    {row.missing.some((name) => TEMPLATE_VARIABLES[name].source === "manual")
                      ? " — preenche o valor no rascunho"
                      : " — corrige o contacto ou retira-o da lista"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {campaign.messageType === "PROMOTIONAL" && preview.purposeBreakdown.length > 0 ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Finalidade do último opt-in dos destinatários elegíveis</h3>
              <ul className="mt-1 text-sm">
                {preview.purposeBreakdown.map((row) => (
                  <li key={row.purpose}>{row.purpose}: {row.count}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {example && example.eligible ? (
            <div className="mt-4">
              <h3 className="text-sm font-semibold">Exemplo da mensagem final</h3>
              <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{example.renderedBody}</p>
            </div>
          ) : null}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="mb-1 text-left font-semibold">
                Destinatários elegíveis{plan.counts.eligible > PREVIEW_ROWS ? ` (primeiros ${PREVIEW_ROWS} de ${plan.counts.eligible})` : ""}
              </caption>
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2">Contacto</th>
                  <th className="px-3 py-2">{canSend ? "Número (E.164)" : "Telefone (mascarado)"}</th>
                  <th className="px-3 py-2">Partes</th>
                  <th className="px-3 py-2">Mensagem</th>
                </tr>
              </thead>
              <tbody>
                {eligibleRows.map((row) =>
                  row.eligible ? (
                    <tr key={row.contactId} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2">{preview.members.get(row.contactId)?.name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {canSend
                          ? preview.members.get(row.contactId)?.phoneE164
                          : maskPhoneNumber(preview.members.get(row.contactId)?.phoneE164 ?? "")}
                      </td>
                      <td className="px-3 py-2">{row.segments.segments} ({row.segments.encoding === "GSM_7" ? "GSM-7" : "UCS-2"})</td>
                      <td className="px-3 py-2 text-slate-600">{row.renderedBody}</td>
                    </tr>
                  ) : null,
                )}
                {eligibleRows.length === 0 ? (
                  <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-500">Nenhum destinatário elegível.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {excludedRows.length > 0 ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold">Excluídos ({plan.recipients.length - plan.counts.eligible})</summary>
              <ul className="mt-2 space-y-1 text-sm">
                {excludedRows.map((row) =>
                  row.eligible ? null : (
                    <li key={row.contactId}>
                      {preview.members.get(row.contactId)?.name} · {maskPhoneNumber(preview.members.get(row.contactId)?.phoneE164 ?? "")} ·{" "}
                      {SKIP_REASON_LABELS[row.reason]}
                    </li>
                  ),
                )}
              </ul>
            </details>
          ) : null}

          {canSend && plan.blockers.length === 0 ? (
            <div className="mt-6 border-t border-slate-100 pt-4">
              <ConfirmForm
                key={preview.fingerprint}
                campaignId={campaign.id}
                fingerprint={preview.fingerprint}
                requiredText={preview.requiredConfirmationText}
                promotional={campaign.messageType === "PROMOTIONAL"}
                eligible={plan.counts.eligible}
                requiredParts={plan.counts.totalSegments}
                quotaRemainingAfter={
                  preview.quota
                    ? Math.max(0, preview.quota.remaining - preview.quota.committedElsewhere.parts - plan.counts.totalSegments)
                    : null
                }
              />
            </div>
          ) : null}
        </section>

        {canWrite ? (
          <section className="rounded-xl border border-red-200 bg-white p-5">
            <h2 className="font-semibold text-red-800">Eliminar rascunho</h2>
            <form action={deleteCampaignDraftAction.bind(null, campaign.id)} className="mt-3 flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="confirm" required /> Confirmo que quero eliminar este rascunho
              </label>
              <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white">Eliminar</button>
            </form>
          </section>
        ) : null}
      </div>
    );
  }

  // ------------------------------------------------------ confirmada / final
  if (campaign.status === "CANCELLED" && !campaign.finishedAt) {
    await reconcileCampaign(campaign.id, { now: () => new Date(), logger: { log: () => {} } });
  }
  const [counts, messagesCount, problems, deliveryGroups] = await Promise.all([
    recipientCounts(campaign.id),
    prisma.smsMessage.count({ where: { campaignId: campaign.id } }),
    prisma.campaignRecipient.findMany({
      where: { campaignId: campaign.id, status: { in: ["FAILED", "UNKNOWN", "SKIPPED", "CANCELLED"] } },
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { contact: { select: { id: true, name: true, phoneE164: true } } },
    }),
    prisma.smsMessage.groupBy({ by: ["status"], where: { campaignId: campaign.id }, _count: { _all: true } }),
  ]);
  const delivery = Object.fromEntries(deliveryGroups.map((row) => [row.status, row._count._all])) as Record<string, number>;
  let currentMode: string | null = null;
  try {
    currentMode = getSmsRuntimeConfig().mode;
  } catch {
    currentMode = null;
  }
  const canRevert =
    canSend &&
    messagesCount === 0 &&
    (campaign.status === "READY" || (campaign.status === "SENDING" && campaign.pausedAt !== null));

  return (
    <div className="max-w-5xl space-y-6">
      <div>{header}</div>
      {campaign.mode === "TEST" ? <TestModeBanner /> : null}
      {currentMode && campaign.mode && currentMode !== campaign.mode && ["READY", "SENDING"].includes(campaign.status) ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Atenção: a campanha foi confirmada em modo {campaign.mode === "TEST" ? "TESTE" : "PRODUÇÃO"} e a aplicação está
          agora em modo {currentMode === "TEST" ? "TESTE" : "PRODUÇÃO"}. O envio está bloqueado.
        </div>
      ) : null}

      <CampaignRunner
        key={`${campaign.status}:${campaign.pausedAt?.toISOString() ?? ""}`}
        campaignId={campaign.id}
        canSend={canSend}
        canRevert={canRevert}
        initial={{
          state: "progress",
          status: campaign.status,
          counts,
          lastError: campaign.lastError,
          paused: campaign.pausedAt !== null,
          retryAfterMs: 0,
        }}
      />

      <section className={card}>
        <h2 className="text-lg font-semibold">Resumo confirmado</h2>
        <div className="mt-3">
          <Summary
            rows={[
              ["Tipo", typeLabel],
              ["Lista", campaign.list?.name ?? "—"],
              ["Template", campaign.template?.name ?? "Texto livre"],
              ["Modo", campaign.mode === "TEST" ? "TESTE" : "PRODUÇÃO"],
              ["Confirmada por", `${campaign.confirmedBy?.name ?? "—"}${campaign.confirmedAt ? ` em ${formatLisbon(campaign.confirmedAt)}` : ""}`],
              [
                "Ritmo máximo",
                campaign.maxSendsPerMinute !== null ? `${campaign.maxSendsPerMinute} mensagens/minuto (definido nesta campanha)` : "limite global",
              ],
              ["Quota diária debitada a", campaign.confirmedBy?.name ?? "—"],
              ["Início", campaign.startedAt ? formatLisbon(campaign.startedAt) : "—"],
              ["Fim", campaign.finishedAt ? formatLisbon(campaign.finishedAt) : "—"],
              [
                "Entrega (eventos AWS)",
                `${delivery.DELIVERED ?? 0} entregues · ${(delivery.SENT ?? 0) + (delivery.QUEUED ?? 0)} em trânsito · ${(delivery.FAILED ?? 0) + (delivery.UNROUTABLE ?? 0) + (delivery.PROTECT_BLOCKED ?? 0)} falhadas · ${delivery.ACCEPTED ?? 0} só aceites`,
              ],
            ]}
          />
        </div>
        <p className="mt-3 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 font-mono text-sm">{campaign.messageBody}</p>
        <Link href={`/messages?campaignId=${campaign.id}`} className="mt-3 inline-block text-sm font-semibold underline">
          Ver mensagens enviadas ({messagesCount})
        </Link>
      </section>

      {problems.length > 0 ? (
        <section className={card}>
          <h2 className="text-lg font-semibold">Destinatários não enviados ou com problemas</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2">Contacto</th>
                  <th className="px-3 py-2">Telefone</th>
                  <th className="px-3 py-2">Estado</th>
                  <th className="px-3 py-2">Motivo</th>
                </tr>
              </thead>
              <tbody>
                {problems.map((row) => (
                  <tr key={row.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      {row.contact ? <Link href={`/contacts/${row.contact.id}`} className="hover:underline">{row.contact.name}</Link> : "Contacto eliminado"}
                    </td>
                    <td className="px-3 py-2">{row.contact ? maskPhoneNumber(row.contact.phoneE164) : "—"}</td>
                    <td className="px-3 py-2">{RECIPIENT_STATUS_LABELS[row.status]}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {row.skipReason ? SKIP_REASON_LABELS[row.skipReason] ?? row.skipReason : row.errorCode ?? "—"}
                      {row.status === "UNKNOWN" ? " — não reenviar sem verificar" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
