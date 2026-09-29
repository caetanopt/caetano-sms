import { createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { evaluateLoginThrottle, LOGIN_WINDOW_MS } from "@/features/auth/login-throttle";
import { prisma } from "@/lib/db/prisma";

// Hash bcrypt válido para comparar quando o utilizador não existe (tempo constante).
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5y0ZMpf9j3UJmKkhm6fYHq.cyZqAEgK";

function hmac(value: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(value).digest("hex");
}

export type LoginResult =
  | { ok: true; user: { id: string; email: string; name: string; role: "ADMIN" | "OPERATOR" | "VIEWER" } }
  | { ok: false; reason: "invalid" | "blocked"; retryAfterMs?: number };

export async function attemptLogin(input: { email: string; password: string; ip: string | null; now?: Date }): Promise<LoginResult> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const emailHash = hmac(`email:${email}`);
  const ipHash = input.ip ? hmac(`ip:${input.ip}`) : null;
  const since = new Date(now.getTime() - LOGIN_WINDOW_MS);

  const [emailFailures, ipFailures] = await Promise.all([
    prisma.loginAttempt.findMany({ where: { emailHash, success: false, createdAt: { gt: since } }, select: { createdAt: true } }),
    ipHash
      ? prisma.loginAttempt.findMany({ where: { ipHash, success: false, createdAt: { gt: since } }, select: { createdAt: true } })
      : Promise.resolve([]),
  ]);
  const decision = evaluateLoginThrottle({
    now,
    emailFailures: emailFailures.map((row) => row.createdAt),
    ipFailures: ipFailures.map((row) => row.createdAt),
  });

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
  await prisma.$transaction([
    prisma.loginAttempt.create({ data: { emailHash, ipHash, success } }),
    prisma.auditLog.create({
      data: {
        userId: user?.id ?? null,
        action: success ? "LOGIN_SUCCEEDED" : "LOGIN_FAILED",
        entityType: "User",
        entityId: user?.id,
        ipAddress: input.ip,
        metadataJson: success ? {} : { reason: user ? (user.isActive ? "password" : "inactive") : "unknown_user" },
      },
    }),
  ]);
  if (!success || !user) return { ok: false, reason: "invalid" };
  return { ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
}
