"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIpFromHeaders } from "@/features/auth/login-throttle";
import { createMfaPending } from "@/lib/auth/mfa-pending";
import { createSession, destroyAllSessions, destroySession, requireUser } from "@/lib/auth/session";
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
  const { revocationFailed } = await destroySession();
  // O browser já não tem a sessão, mas uma cópia do token pode continuar válida: avisar.
  if (revocationFailed) {
    return redirectWith("/login", {
      error: "Saíste neste browser, mas o servidor não confirmou o fim da sessão. Quando possível, entra e usa «Sair de todos os dispositivos».",
    });
  }
  redirect("/login");
}

/** Termina todas as sessões do próprio utilizador (ex.: esqueceu-se de sair noutro computador). */
export async function logoutAllAction() {
  await requireUser({ allowPasswordChange: true, allowMfaSetup: true });
  await destroyAllSessions();
  return redirectWith("/login", { success: "Sessão terminada em todos os dispositivos." });
}
