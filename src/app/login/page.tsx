import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { readSession } from "@/lib/auth/session";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await readSession()) redirect("/dashboard");
  const params = await searchParams;

  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm border border-slate-200">
        <p className="text-sm font-semibold text-indigo-600">SMS AWS</p>
        <h1 className="mt-2 text-2xl font-bold">Iniciar sessão</h1>
        <p className="mt-2 text-sm text-slate-600">
          Acesso reservado a utilizadores autorizados.
        </p>

        {params.error ? (
          <div className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">{params.error}</div>
        ) : null}

        <form action={loginAction} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Email
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium">
            Palavra-passe
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <button className="w-full rounded-lg bg-slate-900 px-4 py-2.5 font-semibold text-white hover:bg-slate-800">
            Entrar
          </button>
        </form>
      </div>
    </main>
  );
}
