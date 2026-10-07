"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIpFromHeaders } from "@/features/auth/login-throttle";
import { createMfaPending } from "@/lib/auth/mfa-pending";
import { createSession, destroySession } from "@/lib/auth/session";
import { redirectWith } from "@/lib/http/redirect-with";
import { attemptLogin } from "@/server/services/login";

const loginSchema = z.object({
  email: z.email().max(200),
  password: z.string().min(1).max(200),
});

export async function loginAction(formData: FormData) {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return redirectWith("/login", { error: "Dados inválidos" });

  const ip = clientIpFromHeaders(await headers(), process.env.TRUST_PROXY === "true");
  const result = await attemptLogin({ ...parsed.data, ip });
  if (!result.ok) {
    // A mensagem nunca revela se a conta existe.
    return redirectWith("/login", {
      error:
        result.reason === "blocked"
          ? `Demasiadas tentativas falhadas. Tenta novamente dentro de ${Math.ceil((result.retryAfterMs ?? 60_000) / 60_000)} min.`
          : "Credenciais inválidas",
    });
  }

  // Com 2FA ativo, a sessão só é criada depois do segundo fator (/login/mfa).
  if (result.user.mfaRequired) {
    await createMfaPending({ userId: result.user.id, sessionVersion: result.user.sessionVersion });
    redirect("/login/mfa");
  }
  await createSession({
    userId: result.user.id,
    email: result.user.email,
    name: result.user.name,
    role: result.user.role,
    sessionVersion: result.user.sessionVersion,
    mfa: false,
  });
  redirect(result.user.mustChangePassword ? "/account/password" : "/dashboard");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
