import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { ChangePasswordForm } from "@/components/users/change-password-form";
import { MIN_PASSWORD_LENGTH } from "@/features/auth/password-policy";
import { requireUser } from "@/lib/auth/session";

/** Fora do layout (dashboard): acessível mesmo com palavra-passe temporária, sem navegação para o resto da app. */
export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string }>;
}) {
  const user = await requireUser({ allowPasswordChange: true });
  const { success } = await searchParams;

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold text-indigo-600">SMS AWS</p>
        <h1 className="mt-2 text-2xl font-bold">Alterar palavra-passe</h1>
        <p className="mt-2 text-sm text-slate-600">{user.name} · {user.email}</p>
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
        <div className="mt-6 flex justify-between text-sm">
          {user.mustChangePassword ? <span /> : <Link href="/dashboard" className="text-slate-600 hover:underline">← Voltar</Link>}
          <form action={logoutAction}>
            <button className="text-slate-600 hover:underline">Sair</button>
          </form>
        </div>
      </div>
    </main>
  );
}
