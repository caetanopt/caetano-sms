import { getCampaignLimits } from "@/features/campaigns/limits";
import { initialSendFormState } from "@/features/messages/send-form-state";
import { describeQuota } from "@/features/rate-limit/quota";
import { getUserQuotaSnapshot, type UserQuotaSnapshot } from "@/server/services/send-rate";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { getSmsRuntimeConfig } from "@/lib/sms/config";
import { SendForm } from "./send-form";

function readMode() {
  try {
    return getSmsRuntimeConfig().mode;
  } catch {
    return null;
  }
}

export default async function SendPage() {
  const user = await requireUser();
  const mode = readMode();
  // Quota diária do operador (informativa; a verificação final acontece ao confirmar).
  let quota: UserQuotaSnapshot | null = null;
  if (user.role !== "VIEWER") {
    try {
      quota = await getUserQuotaSnapshot(user.id, getCampaignLimits().userDailyParts);
    } catch {
      quota = null;
    }
  }
  const templates =
    user.role === "VIEWER"
      ? []
      : await prisma.smsTemplate.findMany({
          orderBy: { name: "asc" },
          select: { id: true, name: true, body: true, messageType: true },
        });

  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold">Enviar SMS</h1>
      <p className="mt-2 text-slate-600">Envio individual com validação, confirmação e registo de auditoria.</p>

      {mode === "TEST" ? (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          MODO DE TESTE — nenhum SMS real será enviado
        </div>
      ) : mode === "PRODUCTION" ? (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          MODO PRODUÇÃO — os SMS serão enviados através da AWS. Confirma cuidadosamente o destinatário e a mensagem.
        </div>
      ) : (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          O serviço de envio não está configurado corretamente. Contacta um administrador.
        </div>
      )}

      {quota ? (
        <p className="mt-3 text-sm text-slate-600">
          Quota diária: {describeQuota(quota)}
          {quota.committedElsewhere.parts > 0
            ? ` · ${quota.committedElsewhere.parts} reservadas para campanhas tuas por enviar (${quota.committedElsewhere.campaigns.map((c) => `«${c.name}»`).join(", ")})`
            : ""}
        </p>
      ) : null}
      {quota && quota.limit === 0 ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          A tua conta não tem quota de envio de SMS. Contacta um administrador.
        </div>
      ) : quota && quota.remaining === 0 ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Quota diária esgotada: podes preparar a mensagem, mas o envio só será possível depois das 00:00 (hora de Lisboa) ou se
          um administrador ajustar a quota.
        </div>
      ) : null}

      {user.role === "VIEWER" ? (
        <p className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          O teu perfil (apenas leitura) não permite enviar SMS.
        </p>
      ) : mode ? (
        <SendForm initialState={initialSendFormState(crypto.randomUUID())} templates={templates} />
      ) : null}
    </div>
  );
}
