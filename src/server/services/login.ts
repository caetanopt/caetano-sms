import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { evaluateLoginThrottle, LOGIN_WINDOW_MS } from "@/features/auth/login-throttle";
import { prisma } from "@/lib/db/prisma";

// Hash bcrypt válido para comparar quando o utilizador não existe (tempo constante).
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5y0ZMpf9j3UJmKkhm6fYHq.cyZqAEgK";

function hmac(value: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(value).digest("hex");
}

/** Identificadores das tentativas (só HMAC: nunca email/IP em claro). */
export function attemptIdentifiers(email: string, ip: string | null) {
  return { emailHash: hmac(`email:${email.trim().toLowerCase()}`), ipHash: ip ? hmac(`ip:${ip}`) : null };
}

/** Bloqueio partilhado por palavra-passe e segundo fator (5 falhas/email, 20/IP em 15 min). */
export async function checkAttemptThrottle(ids: { emailHash: string; ipHash: string | null }, now: Date) {
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS);
  const [emailFailures, ipFailures] = await Promise.all([
    prisma.loginAttempt.findMany({ where: { emailHash: ids.emailHash, success: false, createdAt: { gt: since } }, select: { createdAt: true } }),
    ids.ipHash
      ? prisma.loginAttempt.findMany({ where: { ipHash: ids.ipHash, success: false, createdAt: { gt: since } }, select: { createdAt: true } })
      : Promise.resolve([]),
  ]);
  return evaluateLoginThrottle({
    now,
    emailFailures: emailFailures.map((row) => row.createdAt),
    ipFailures: ipFailures.map((row) => row.createdAt),
  });
}

export type LoginResult =
  | {
      ok: true;
      user: {
        id: string;
        email: string;
        name: string;
        role: "ADMIN" | "OPERATOR" | "VIEWER";
        sessionVersion: number;
        mustChangePassword: boolean;
        /** Falta o segundo fator: a sessão só é criada depois de /login/mfa. */
        mfaRequired: boolean;
      };
    }
  | { ok: false; reason: "invalid" | "blocked"; retryAfterMs?: number };

export async function attemptLogin(input: { email: string; password: string; ip: string | null; now?: Date }): Promise<LoginResult> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const { emailHash, ipHash } = attemptIdentifiers(email, input.ip);
  const decision = await checkAttemptThrottle({ emailHash, ipHash }, now);

  const user = await prisma.user.findUnique({ where: { email } });
  if (!decision.allowed) {
    // Não compara a palavra-passe nem regista falha: o bloqueio não se prolonga sozinho.
    await prisma.auditLog.create({
      data: { userId: user?.id ?? null, action: "LOGIN_BLOCKED", entityType: "User", entityId: user?.id, ipAddress: input.ip, metadataJson: {} },
    });
    return { ok: false, reason: "blocked", retryAfterMs: decision.retryAfterMs };
  }

  const passwordOk = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
  const success = Boolean(user?.isActive && passwordOk);
  const mfaRequired = Boolean(success && user?.totpEnabledAt);
  await prisma.$transaction([
    prisma.loginAttempt.create({ data: { emailHash, ipHash, success } }),
    prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: success ? (mfaRequired ? "LOGIN_PASSWORD_VERIFIED" : "LOGIN_SUCCEEDED") : "LOGIN_FAILED",
        entityType: "User",
        entityId: user?.id,
        ipAddress: input.ip,
        metadataJson: success ? {} : { reason: user ? (user.isActive ? "password" : "inactive") : "unknown_user" },
      },
    }),
  ]);
  if (!success || !user) return { ok: false, reason: "invalid" };
  if (!mfaRequired) await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
  return {
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      sessionVersion: user.sessionVersion,
      mustChangePassword: user.mustChangePassword,
      mfaRequired,
    },
  };
}
