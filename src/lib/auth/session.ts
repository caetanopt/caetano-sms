import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { mfaRequiredFor } from "@/features/auth/mfa-policy";
import { clearMfaPending } from "@/lib/auth/mfa-pending";
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

/** Sessão lida do cookie: identificador do token (para o logout deste dispositivo) e expiração. */
export type ActiveSession = SessionClaims & { jti: string; expiresAt: Date };

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
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secret());

  const jar = await cookies();
  jar.set(hostCookieName(SESSION_COOKIE), token, hostCookieOptions({ sameSite: "lax", maxAge: SESSION_HOURS * 60 * 60 }));
  await deleteLegacyCookie(SESSION_COOKIE);
  // Um passo de 2FA a meio (ex.: outra pessoa no mesmo computador) não sobrevive a um novo login.
  await clearMfaPending();
  // Cookie de mensagens novo a cada login (ver rotateFlashCookie).
  await rotateFlashCookie();
}

/**
 * Logout deste dispositivo: revoga o token atual no servidor (pelo `jti`) e apaga os cookies. O
 * token é stateless (JWT de 8 h): sem revogação, uma cópia obtida antes do logout (computador
 * partilhado, cópia do perfil do browser) continuaria válida. As outras sessões do utilizador
 * mantêm-se; terminar todas é feito pelas ações de administração (`sessionVersion`).
 */
export async function destroySession() {
  const session = await readSession();
  if (session) {
    const { count } = await prisma.revokedSession.createMany({
      data: [{ jti: session.jti, userId: session.userId, expiresAt: session.expiresAt }],
      skipDuplicates: true,
    });
    if (count === 1) {
      await prisma.auditLog.create({
        data: { userId: session.userId, action: "LOGOUT", entityType: "User", entityId: session.userId, metadataJson: { scope: "device" } },
      });
    }
  }
  await deleteHostCookie(SESSION_COOKIE, "lax");
  await deleteLegacyCookie(SESSION_COOKIE);
  await clearMfaPending();
  await clearFlashCookie();
}

export async function readSession(): Promise<ActiveSession | null> {
  const jar = await cookies();
  const token = jar.get(hostCookieName(SESSION_COOKIE))?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub || !payload.email || !payload.name || !payload.role) return null;
    // Tokens sem jti (anteriores ao logout por dispositivo) não podem ser revogados: recusados.
    if (typeof payload.jti !== "string" || !payload.jti || typeof payload.exp !== "number") return null;
    return {
      jti: payload.jti,
      expiresAt: new Date(payload.exp * 1000),
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
function findSessionUser(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
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
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await readSession();
  if (!session) return null;
  const [user, revoked] = await Promise.all([
    findSessionUser(session.userId),
    prisma.revokedSession.findUnique({ where: { jti: session.jti }, select: { jti: true } }),
  ]);
  // Sessão terminada com logout neste dispositivo (uma cópia do token deixa de servir).
  if (revoked) return null;
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
