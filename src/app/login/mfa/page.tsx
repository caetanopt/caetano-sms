import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthLayout } from "@/components/auth-layout";
import { MfaLoginForm } from "@/components/mfa/mfa-login-form";
import { readMfaPending } from "@/lib/auth/mfa-pending";

export default async function MfaLoginPage() {
  if (!(await readMfaPending())) redirect("/login");
  return (
    <AuthLayout title="Verificação em dois passos" subtitle="Introduz o código atual da tua app de autenticação.">
        <MfaLoginForm />
        <p className="mt-6 text-sm">
          <Link href="/login" className="text-slate-600 hover:underline">← Voltar ao início de sessão</Link>
        </p>
    </AuthLayout>
  );
}
