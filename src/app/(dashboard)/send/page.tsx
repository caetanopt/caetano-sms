import { sendSmsAction } from "@/app/actions/send-sms";
import { requireUser } from "@/lib/auth/session";

export default async function SendPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const dryRun = process.env.SMS_PROVIDER !== "aws" || process.env.AWS_SMS_DRY_RUN !== "false";
  const requestId = crypto.randomUUID();

  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold">Enviar SMS</h1>
      <p className="mt-2 text-slate-600">Envio individual com validação e registo de auditoria.</p>

      {dryRun ? (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-900">
          MODO DE TESTE — com a configuração atual não deve ser enviado um SMS real.
        </div>
      ) : (
        <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
          MODO AWS REAL — confirma cuidadosamente o destinatário e a mensagem.
        </div>
      )}

      {params.success ? (
        <div className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{params.success}</div>
      ) : null}
      {params.error ? (
        <div className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-800">{params.error}</div>
      ) : null}

      <form action={sendSmsAction} className="mt-6 space-y-5 rounded-xl border border-slate-200 bg-white p-6">
        <input type="hidden" name="requestId" value={requestId} />
        <label className="block text-sm font-medium">
          Destinatário
          <input
            name="phone"
            required
            placeholder="+351912345678"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>

        <label className="block text-sm font-medium">
          Tipo de mensagem
          <select name="messageType" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            <option value="TRANSACTIONAL">Transacional</option>
            <option value="PROMOTIONAL">Promocional</option>
          </select>
        </label>

        <label className="block text-sm font-medium">
          Mensagem
          <textarea
            name="message"
            required
            rows={7}
            maxLength={1530}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            placeholder="Escreve a mensagem..."
          />
        </label>

        <label className="flex items-start gap-3 text-sm text-slate-700">
          <input name="legalBasis" type="checkbox" className="mt-1" />
          <span>
            Para um número ainda não registado como contacto, confirmo que existe consentimento/base legal adequada,
            especialmente se a mensagem for promocional.
          </span>
        </label>

        <button className="rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-800">
          Confirmar e enviar
        </button>
      </form>
    </div>
  );
}
