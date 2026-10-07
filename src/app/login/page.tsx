import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { AuthLayout } from "@/components/auth-layout";
import { getCurrentUser } from "@/lib/auth/session";
import { readFlash } from "@/lib/http/flash";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Sessão inválida (versão antiga, conta desativada) não conta: evita ciclo de redirecionamentos.
  if (await getCurrentUser()) redirect("/dashboard");
  const params = await searchParams;
  const flash = readFlash(params, "/login");

  return (
    <AuthLayout title="Iniciar sessão" subtitle="Acesso reservado a utilizadores autorizados.">
      {flash.error ? (
        <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{flash.error}</div>
      ) : null}

      <form action={loginAction} className="mt-6 space-y-4">
        <label className="block text-sm font-medium text-brand-deep">
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-2.5"
          />
        </label>
        <label className="block text-sm font-medium text-brand-deep">
          Palavra-passe
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-4 py-2.5"
          />
        </label>
        <button className="group relative w-full overflow-hidden rounded-xl bg-brand-deep px-4 py-3 font-semibold text-white shadow-[0_12px_28px_-14px_rgb(0_46_93/0.8)] hover:bg-slate-800">
          <span className="relative z-10">Entrar</span>
          <span aria-hidden="true" className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/15 to-transparent transition-transform duration-700 group-hover:translate-x-full" />
        </button>
      </form>
    </AuthLayout>
  );
}
