import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { Feedback } from "@/components/feedback";
import { MfaPanel } from "@/components/mfa/mfa-panel";
import { requireUser } from "@/lib/auth/session";
import { formatLisbon } from "@/lib/time/lisbon";
import { getMfaStatus } from "@/server/services/mfa";

/** Fora do layout (dashboard): acessível quando o 2FA ainda é obrigatório e está por configurar. */
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string; error?: string }>;
}) {
  const user = await requireUser({ allowMfaSetup: true });
  const params = await searchParams;
  const status = await getMfaStatus(user.id);

  return (
    <main className="min-h-screen p-6">
      <div className="mx-auto w-full max-w-2xl">
        <p className="text-sm font-semibold text-indigo-600">SMS AWS</p>
        <h1 className="mt-2 text-2xl font-bold">Verificação em dois passos (2FA)</h1>
        <p className="mt-2 text-sm text-slate-600">{user.name} · {user.email}</p>
        {user.mfaSetupRequired ? (
          <div role="alert" className="mt-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Os administradores têm de usar 2FA. Configura-o para continuar.
          </div>
        ) : null}
        {params.notice === "recovery" ? (
          <div role="alert" className="mt-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Entraste com um código de recuperação (já não pode ser usado de novo). Se perdeste o telemóvel, considera pedir a
            reposição do 2FA ou gera novos códigos.
          </div>
        ) : null}
        <Feedback error={params.error} />
        <div className="mt-6">
          {status ? (
            <MfaPanel
              status={{
                enabled: status.enabled,
                enabledAt: status.enabledAt ? formatLisbon(status.enabledAt) : null,
                recoveryCodesRemaining: status.recoveryCodesRemaining,
                required: status.required,
                pending: status.pending ? { secretDisplay: status.pending.secretDisplay, uri: status.pending.uri } : null,
              }}
            />
          ) : null}
        </div>
        <div className="mt-8 flex justify-between text-sm">
          {user.mfaSetupRequired ? <span /> : <Link href="/dashboard" className="text-slate-600 hover:underline">← Voltar</Link>}
          <form action={logoutAction}>
            <button className="text-slate-600 hover:underline">Sair</button>
          </form>
        </div>
      </div>
    </main>
  );
}
