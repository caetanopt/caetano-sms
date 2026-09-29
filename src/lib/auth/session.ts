import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";

const COOKIE_NAME = "sms_session";
const SESSION_HOURS = 8;

export type SessionClaims = {
  userId: string;
  email: string;
  name: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  /** Versão de sessão do utilizador no momento do login. */
  sessionVersion: number;
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
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(secret());

  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 60 * 60,
  });
}

export async function destroySession() {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export async function readSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
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
    select: { id: true, name: true, email: true, role: true, isActive: true, sessionVersion: true, mustChangePassword: true },
  });
  if (!user?.isActive || user.sessionVersion !== session.sessionVersion) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role, mustChangePassword: user.mustChangePassword };
}

/**
 * Exige sessão válida. Com palavra-passe temporária, só a página de alteração é permitida
 * (`allowPasswordChange`); tudo o resto redireciona para lá.
 */
export async function requireUser(options: { allowPasswordChange?: boolean } = {}): Promise<CurrentUser> {
  const session = await readSession();
  if (!session) redirect("/login");
  const user = await getCurrentUser();
  // Não apagar o cookie aqui: em Server Components não é permitido. O login seguinte substitui-o.
  if (!user) redirect("/login?error=Sess%C3%A3o%20terminada%3A%20inicia%20sess%C3%A3o%20novamente");
  if (user.mustChangePassword && !options.allowPasswordChange) redirect("/account/password");
  return user;
}
