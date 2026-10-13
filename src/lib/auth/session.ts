import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { mfaRequiredFor } from "@/features/auth/mfa-policy";
import { clearMfaPending } from "@/lib/auth/mfa-pending";
import { prisma } from "@/lib/db/prisma";
import { clearFlashCookie, flashUrl, rotateFlashCookie } from "@/lib/http/flash";
import { deleteHostCookie, deleteLegacyCookie, hostCookieName, hostCookieOptions } from "@/lib/http/host-cookies";
import { consoleLogger } from "@/lib/logging/logger";

/** `__Host-sms_session` em produção (ver `host-cookies.ts`). */
const SESSION_COOKIE = "sms_session";
const SESSION_HOURS = 8;
/** Campos do utilizador que decidem se um token ainda é válido (ver `sessionMatchesUser`). */
const SESSION_CHECK_FIELDS = { isActive: true, sessionVersion: true, totpEnabledAt: true } as const;

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

  // O token que este browser tinha deixa de servir (ex.: login repetido num separador antigo, ou
  // outra pessoa no mesmo computador). Sem isto, o logout seguinte só revogaria o token novo e uma
  // cópia do anterior continuaria válida. Lido antes de escrever o cookie novo.
  const previous = await readSession();
  if (previous) {
    await prisma.revokedSession.createMany({ data: [revocationOf(previous)], skipDuplicates: true });
  }

  const jar = await cookies();
  jar.set(hostCookieName(SESSION_COOKIE), token, hostCookieOptions({ sameSite: "lax", maxAge: SESSION_HOURS * 60 * 60 }));
  await deleteLegacyCookie(SESSION_COOKIE);
  // Um passo de 2FA a meio (ex.: outra pessoa no mesmo computador) não sobrevive a um novo login.
  await clearMfaPending();
  // Cookie de mensagens novo a cada login (ver rotateFlashCookie).
  await rotateFlashCookie();
}

function revocationOf(session: ActiveSession) {
  return { jti: session.jti, userId: session.userId, expiresAt: session.expiresAt };
}

/**
 * Logout deste dispositivo: revoga o token atual no servidor (pelo `jti`) e apaga os cookies. O
 * token é stateless (JWT de 8 h): sem revogação, uma cópia obtida antes do logout (computador
 * partilhado, cópia do perfil do browser) continuaria válida. As outras sessões do utilizador
 * mantêm-se; para as terminar todas, ver `destroyAllSessions`.
 *
 * Os cookies são apagados mesmo que a revogação falhe (ex.: base de dados indisponível): num
 * computador partilhado, a sessão não pode ficar no browser só porque o servidor falhou. Nesse
 * caso devolve `revocationFailed` para avisar o utilizador.
 */
export async function destroySession(): Promise<{ revocationFailed: boolean }> {
  const session = await readSession();
  let revocationFailed = false;
  if (session) {
    try {
      await revokeSession(session);
    } catch (error) {
      revocationFailed = true;
      consoleLogger.log("error", "auth.logout.revocation_failed", { userId: session.userId, errorCode: errorCodeOf(error) });
    }
  }
  await clearSessionCookies();
  return { revocationFailed };
}

/** Revogação e auditoria na mesma transação: um registo LOGOUT nunca se perde numa repetição. */
async function revokeSession(session: ActiveSession) {
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: session.userId }, select: SESSION_CHECK_FIELDS });
    const { count } = await tx.revokedSession.createMany({ data: [revocationOf(session)], skipDuplicates: true });
    if (count === 0) return; // já revogada (logout repetido com o mesmo token)
    await tx.auditLog.create({
      data: {
        // Sem utilizador (apagado diretamente na base de dados), a auditoria não pode falhar pela FK.
        userId: user ? session.userId : null,
        action: "LOGOUT",
        entityType: "User",
        entityId: session.userId,
        // Token já inválido (conta desativada, palavra-passe reposta…): fica registado, mas assinalado.
        metadataJson: sessionMatchesUser(session, user) ? { scope: "device" } : { scope: "device", sessionValid: false },
      },
    });
  });
}

/**
 * Logout em todos os dispositivos (pedido pelo próprio utilizador): incrementar `sessionVersion`
 * invalida todos os tokens já emitidos, incluindo cópias e sessões esquecidas noutro computador,
 * e apaga os cookies deste browser. Só uma sessão válida o pode pedir: um token antigo ou revogado
 * não termina as sessões atuais de ninguém. Se a base de dados falhar, o erro propaga-se e os
 * cookies ficam (o utilizador vê o erro e pode tentar de novo).
 */
export async function destroyAllSessions(): Promise<void> {
  const session = await readSession();
  if (session && (await getCurrentUser())) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.user.updateMany({
        where: { id: session.userId, sessionVersion: session.sessionVersion },
        data: { sessionVersion: { increment: 1 } },
      });
      if (count === 1) {
        await tx.auditLog.create({
          data: { userId: session.userId, action: "LOGOUT", entityType: "User", entityId: session.userId, metadataJson: { scope: "all" } },
        });
      }
    });
  }
  await clearSessionCookies();
}

async function clearSessionCookies() {
  await deleteHostCookie(SESSION_COOKIE, "lax");
  await deleteLegacyCookie(SESSION_COOKIE);
  await clearMfaPending();
  await clearFlashCookie();
}

/** Código do erro para o log (ex.: código Prisma), sem mensagem nem detalhes. */
function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "UNKNOWN";
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
    select: { ...SESSION_CHECK_FIELDS, id: true, name: true, email: true, role: true, mustChangePassword: true },
  });
}

/** O token ainda corresponde ao utilizador: conta ativa, mesma versão de sessão e 2FA coerente. */
function sessionMatchesUser(
  session: ActiveSession,
  user: { isActive: boolean; sessionVersion: number; totpEnabledAt: Date | null } | null,
): boolean {
  if (!user?.isActive || user.sessionVersion !== session.sessionVersion) return false;
  // Com 2FA ativo, uma sessão sem segundo fator nunca é válida.
  return user.totpEnabledAt === null || session.mfa === true;
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
  if (!user || !sessionMatchesUser(session, user)) return null;
  const mfaEnabled = user.totpEnabledAt !== null;
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
