"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIpFromHeaders } from "@/features/auth/login-throttle";
import type { MfaFormState } from "@/features/auth/mfa-form-state";
import { clearMfaPending, readMfaPending } from "@/lib/auth/mfa-pending";
import { createSession, requireUser } from "@/lib/auth/session";
import { flashUrl } from "@/lib/http/flash-params";
import { redirectWith } from "@/lib/http/redirect-with";
import {
  completeMfaLogin,
  confirmMfaEnrollment,
  disableOwnMfa,
  regenerateRecoveryCodes,
  startMfaEnrollment,
} from "@/server/services/mfa";

const codeSchema = z.string().trim().min(6, "Indica o código.").max(20, "Código inválido.");

async function clientIp() {
  return clientIpFromHeaders(await headers(), process.env.TRUST_PROXY === "true");
}

/** Segundo passo do login (após a palavra-passe). */
export async function verifyMfaLoginAction(_previous: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const pending = await readMfaPending();
  if (!pending) redirectWith("/login", { error: "O início de sessão expirou. Introduz novamente a palavra-passe." });
  const code = codeSchema.safeParse(formData.get("code"));
  if (!code.success) return { error: code.error.issues[0]?.message ?? "Código inválido." };

  const result = await completeMfaLogin(pending, code.data, { ip: await clientIp() });
  if (!result.ok) {
    if (/expirou/.test(result.message)) {
      await clearMfaPending();
      redirectWith("/login", { error: result.message });
    }
    return { error: result.message };
  }
  await clearMfaPending();
  const { user, method } = result.value;
  await createSession({ userId: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: user.sessionVersion, mfa: true });
  if (user.mustChangePassword) redirect("/account/password");
  // Código de recuperação usado: avisar e sugerir gerar novos.
  if (method === "recovery") redirect(flashUrl("/account/mfa", { notice: "recovery" }));
  redirect("/dashboard");
}

export async function startMfaEnrollmentAction() {
  const user = await requireUser({ allowMfaSetup: true });
  const result = await startMfaEnrollment(user.id, { ip: await clientIp() });
  if (!result.ok) redirectWith("/account/mfa", { error: result.message });
  redirect("/account/mfa");
}

export async function confirmMfaEnrollmentAction(_previous: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const user = await requireUser({ allowMfaSetup: true });
  const code = codeSchema.safeParse(formData.get("code"));
  if (!code.success) return { error: code.error.issues[0]?.message ?? "Código inválido." };
  const result = await confirmMfaEnrollment(user.id, code.data, { ip: await clientIp() });
  if (!result.ok) return { error: result.message };
  // As outras sessões terminam; esta passa a ter segundo fator.
  await createSession({ userId: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: result.value.sessionVersion, mfa: true });
  return { recoveryCodes: result.value.recoveryCodes };
}

export async function regenerateRecoveryCodesAction(_previous: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const user = await requireUser();
  const code = codeSchema.safeParse(formData.get("code"));
  if (!code.success) return { error: code.error.issues[0]?.message ?? "Código inválido." };
  const result = await regenerateRecoveryCodes(user.id, code.data, { ip: await clientIp() });
  if (!result.ok) return { error: result.message };
  return { recoveryCodes: result.value.recoveryCodes };
}

export async function disableMfaAction(_previous: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const user = await requireUser();
  const code = codeSchema.safeParse(formData.get("code"));
  const password = z.string().min(1, "Indica a palavra-passe.").max(200).safeParse(formData.get("password"));
  if (!code.success || !password.success) return { error: "Indica a palavra-passe e o código." };
  const result = await disableOwnMfa(user.id, { password: password.data, code: code.data }, { ip: await clientIp() });
  if (!result.ok) return { error: result.message };
  await createSession({ userId: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: result.value.sessionVersion, mfa: false });
  return { done: true };
}
