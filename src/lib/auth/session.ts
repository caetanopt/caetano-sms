import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { mfaRequiredFor } from "@/features/auth/mfa-policy";
import { prisma } from "@/lib/db/prisma";
import { clearFlashCookie, flashUrl, rotateFlashCookie } from "@/lib/http/flash";
import { deleteHostCookie, deleteLegacyCookie, hostCookieName, hostCookieOptions } from "@/lib/http/host-cookies";

/** `__Host-sms_session` em produção (ver `host-cookies.ts`). */
const SESSION_COOKIE = "sms_session";
const SESSION_HOURS = 8;

export type SessionClaims = {
  userId: string;
  email: string;
  name: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  /** Versão de sessão do utilizador no momento do login. */
  sessionVersion: number;
  /** A sessão foi autenticada com segundo fator (TOTP ou código de recuperação). */
  mfa?: boolean;
};

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
  return new TextEncoder().encode(value);
}

export async function createSession(claims: SessionClaims) {
  const token = await new SignJWT({
    email: claims.email,
    name: claims.name,
    role: claims.role,
    sv: claims.sessionVersion,
    mfa: claims.mfa === true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secret());

  const jar = await cookies();
  jar.set(hostCookieName(SESSION_COOKIE), token, hostCookieOptions({ sameSite: "lax", maxAge: SESSION_HOURS * 60 * 60 }));
  await deleteLegacyCookie(SESSION_COOKIE);
  // Cookie de mensagens novo a cada login (ver rotateFlashCookie).
  await rotateFlashCookie();
}

export async function destroySession() {
  await deleteHostCookie(SESSION_COOKIE, "lax");
  await deleteLegacyCookie(SESSION_COOKIE);
  await clearFlashCookie();
}

export async function readSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const token = jar.get(hostCookieName(SESSION_COOKIE))?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub || !payload.email || !payload.name || !payload.role) return null;
    return {
      userId: payload.sub,
      email: String(payload.email),
      name: String(payload.name),
      role: payload.role as SessionClaims["role"],
      sessionVersion: typeof payload.sv === "number" ? payload.sv : 0,
      mfa: payload.mfa === true,
    };
  } catch {
    return null;
  }
}

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: SessionClaims["role"];
  mustChangePassword: boolean;
  /** 2FA ativo (a sessão foi obrigatoriamente autenticada com segundo fator). */
  mfaEnabled: boolean;
  /** O perfil exige 2FA e ainda não está configurado: só /account/mfa é permitido. */
  mfaSetupRequired: boolean;
};

/**
 * Utilizador da sessão, validado na base de dados: ativo e com a mesma versão de sessão
 * (repor/alterar palavra-passe, desativar ou mudar o perfil invalida sessões antigas).
 * Nunca confia na role do token.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await readSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      sessionVersion: true,
      mustChangePassword: true,
      totpEnabledAt: true,
    },
  });
  if (!user?.isActive || user.sessionVersion !== session.sessionVersion) return null;
  const mfaEnabled = user.totpEnabledAt !== null;
  // Com 2FA ativo, uma sessão sem segundo fator nunca é válida.
  if (mfaEnabled && !session.mfa) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    mfaEnabled,
    mfaSetupRequired: !mfaEnabled && mfaRequiredFor(user.role),
  };
}

/**
 * Exige sessão válida. Com palavra-passe temporária, só a página de alteração é permitida
 * (`allowPasswordChange`); tudo o resto redireciona para lá.
 */
export async function requireUser(
  options: { allowPasswordChange?: boolean; allowMfaSetup?: boolean } = {},
): Promise<CurrentUser> {
  const session = await readSession();
  if (!session) redirect("/login");
  const user = await getCurrentUser();
  // Não apagar o cookie aqui: em Server Components não é permitido. O login seguinte substitui-o.
  // Numa server action cria o cookie de mensagens se faltar; durante a renderização não é possível
  // e, sem cookie, redireciona sem texto.
  if (!user) redirect(await flashUrl("/login", { error: "Sessão terminada: inicia sessão novamente" }));
  if (user.mustChangePassword && !options.allowPasswordChange) redirect("/account/password");
  if (user.mfaSetupRequired && !options.allowMfaSetup && !user.mustChangePassword) redirect("/account/mfa");
  return user;
}
