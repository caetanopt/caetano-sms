import Link from "next/link";
import { redirect } from "next/navigation";
import { MfaLoginForm } from "@/components/mfa/mfa-login-form";
import { readMfaPending } from "@/lib/auth/mfa-pending";

export default async function MfaLoginPage() {
  if (!(await readMfaPending())) redirect("/login");
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold text-indigo-600">SMS AWS</p>
        <h1 className="mt-2 text-2xl font-bold">Verificação em dois passos</h1>
        <p className="mt-2 text-sm text-slate-600">Introduz o código atual da tua app de autenticação.</p>
        <MfaLoginForm />
        <p className="mt-6 text-sm">
          <Link href="/login" className="text-slate-600 hover:underline">← Voltar ao início de sessão</Link>
        </p>
      </div>
    </main>
  );
}
