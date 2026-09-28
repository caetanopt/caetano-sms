import { initialSendFormState } from "@/features/messages/send-form-state";
import { requireUser } from "@/lib/auth/session";
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

      {user.role === "VIEWER" ? (
        <p className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          O teu perfil (apenas leitura) não permite enviar SMS.
        </p>
      ) : mode ? (
        <SendForm initialState={initialSendFormState(crypto.randomUUID())} />
      ) : null}
    </div>
  );
}
