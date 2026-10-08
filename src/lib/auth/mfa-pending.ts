import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { deleteHostCookie, hostCookieName, hostCookieOptions } from "@/lib/http/host-cookies";

/**
 * Passo intermédio do login com 2FA: a palavra-passe foi validada mas a sessão ainda não
 * existe. Cookie HttpOnly de curta duração, assinado e ligado à versão de sessão.
 */
/** `__Host-sms_mfa_pending` em produção (ver `host-cookies.ts`). */
const MFA_PENDING_COOKIE = "sms_mfa_pending";
export const MFA_PENDING_MINUTES = 5;

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  return new TextEncoder().encode(value);
}

export type MfaPending = { userId: string; sessionVersion: number };

export async function createMfaPending(pending: MfaPending) {
  const token = await new SignJWT({ typ: "mfa-pending", sv: pending.sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(pending.userId)
    .setIssuedAt()
    .setExpirationTime(`${MFA_PENDING_MINUTES}m`)
    .sign(secret());
  const jar = await cookies();
  jar.set(hostCookieName(MFA_PENDING_COOKIE), token, hostCookieOptions({ sameSite: "strict", maxAge: MFA_PENDING_MINUTES * 60 }));
}

export async function readMfaPending(): Promise<MfaPending | null> {
  const token = (await cookies()).get(hostCookieName(MFA_PENDING_COOKIE))?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    // O tipo impede usar um token de sessão como pendente (e vice-versa).
    if (payload.typ !== "mfa-pending" || !payload.sub || typeof payload.sv !== "number") return null;
    return { userId: payload.sub, sessionVersion: payload.sv };
  } catch {
    return null;
  }
}

export async function clearMfaPending() {
  await deleteHostCookie(MFA_PENDING_COOKIE, "strict");
}
