import Link from "next/link";
import { logoutAction, logoutAllAction } from "@/app/actions/auth";
import { AuthLayout } from "@/components/auth-layout";
import { ChangePasswordForm } from "@/components/users/change-password-form";
import { MIN_PASSWORD_LENGTH } from "@/features/auth/password-policy";
import { requireUser } from "@/lib/auth/session";
import { readFlash } from "@/lib/http/flash";

/** Fora do layout (dashboard): acessível mesmo com palavra-passe temporária, sem navegação para o resto da app. */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string }>;
}) {
  const user = await requireUser({ allowPasswordChange: true });
  const { success } = await readFlash(await searchParams, "/account/password");

  return (
    <AuthLayout title="Alterar palavra-passe" subtitle={`${user.name} · ${user.email}`}>
        {user.mustChangePassword ? (
          <div role="alert" className="mt-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
            Estás a usar uma palavra-passe temporária. Define uma nova para continuar.
          </div>
        ) : null}
        {success && !user.mustChangePassword ? (
          <div role="status" className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
            {success} <Link href="/dashboard" className="font-semibold underline">Continuar</Link>
          </div>
        ) : null}
        <ChangePasswordForm minLength={MIN_PASSWORD_LENGTH} />
        <section aria-labelledby="sessions-heading" className="mt-8 border-t border-slate-200 pt-6">
          <h2 id="sessions-heading" className="text-sm font-semibold text-brand-deep">Sessões</h2>
          <p className="mt-1 text-sm text-slate-600">
            «Sair» termina só a sessão neste browser. Se te esqueceste de sair noutro computador, termina a sessão em todos os
            dispositivos, incluindo este.
          </p>
          <form action={logoutAllAction} className="mt-3">
            <button className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-brand-deep hover:border-brand-deep/30 hover:bg-slate-50">
              Sair de todos os dispositivos
            </button>
          </form>
        </section>
        <div className="mt-6 flex justify-between text-sm">
          {user.mustChangePassword ? <span /> : <Link href="/dashboard" className="text-slate-600 hover:underline">← Voltar</Link>}
          <form action={logoutAction}>
            <button className="text-slate-600 hover:underline">Sair</button>
          </form>
        </div>
    </AuthLayout>
  );
}
