import bcrypt from "bcryptjs";
import { mfaIssuer, mfaRequiredFor } from "@/features/auth/mfa-policy";
import {
  base32Encode,
  formatSecretForDisplay,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "@/features/auth/totp";
import { decryptSecret, encryptSecret, hashRecoveryCode } from "@/lib/auth/mfa-crypto";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import type { Actor, ServiceResult } from "./contacts";
import { attemptIdentifiers, checkAttemptThrottle } from "./login";

/** Uma configuração iniciada e não confirmada expira ao fim deste tempo. */
export const MFA_PENDING_TTL_MS = 10 * 60_000;

const INVALID_CODE = { ok: false as const, message: "Código inválido ou já utilizado." };
const BLOCKED = (ms: number) => ({
  ok: false as const,
  message: `Demasiadas tentativas falhadas. Tenta novamente dentro de ${Math.ceil(ms / 60_000)} min.`,
});

type Context = { ip: string | null; now?: Date };

async function audit(userId: string | null, action: string, entityId: string, ip: string | null, metadata: Record<string, string | number | boolean> = {}) {
  await prisma.auditLog.create({ data: { userId, action, entityType: "User", entityId, ipAddress: ip, metadataJson: metadata } });
}

function hashCodes(userId: string, codes: string[]) {
  return codes.map((code) => ({ userId, codeHash: hashRecoveryCode(userId, normalizeRecoveryCode(code) ?? code) }));
}

// ---------------------------------------------------------------------------
// Estado e configuração
// ---------------------------------------------------------------------------

export type MfaStatus = {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesRemaining: number;
  required: boolean;
  pending: { secret: string; secretDisplay: string; uri: string } | null;
};

export async function getMfaStatus(userId: string, now = new Date()): Promise<MfaStatus | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, role: true, totpEnabledAt: true, totpPendingSecretEnc: true, totpPendingAt: true },
  });
  if (!user) return null;
  const recoveryCodesRemaining = await prisma.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  let pending: MfaStatus["pending"] = null;
  if (!user.totpEnabledAt && user.totpPendingSecretEnc && user.totpPendingAt && now.getTime() - user.totpPendingAt.getTime() < MFA_PENDING_TTL_MS) {
    const secret = decryptSecret(user.totpPendingSecretEnc);
    if (secret) {
      const base32 = base32Encode(secret);
      pending = { secret: base32, secretDisplay: formatSecretForDisplay(base32), uri: otpauthUri({ issuer: mfaIssuer(), account: user.email, secretBase32: base32 }) };
    }
  }
  return { enabled: user.totpEnabledAt !== null, enabledAt: user.totpEnabledAt, recoveryCodesRemaining, required: mfaRequiredFor(user.role), pending };
}

/** Gera um novo segredo pendente (substitui um anterior não confirmado). */
export async function startMfaEnrollment(userId: string, ctx: Context): Promise<ServiceResult> {
  const now = ctx.now ?? new Date();
  const { count } = await prisma.user.updateMany({
    where: { id: userId, isActive: true, totpEnabledAt: null },
    data: { totpPendingSecretEnc: encryptSecret(generateTotpSecret()), totpPendingAt: now },
  });
  if (count === 0) return { ok: false, message: "O 2FA já está ativo nesta conta." };
  await audit(userId, "MFA_ENROLLMENT_STARTED", userId, ctx.ip);
  return { ok: true, value: undefined };
}

/**
 * Confirma a configuração com um código da app. Ativa o 2FA, gera códigos de recuperação
 * (mostrados uma única vez) e termina as outras sessões. Devolve a nova versão de sessão.
 */
export async function confirmMfaEnrollment(
  userId: string,
  code: string,
  ctx: Context,
): Promise<ServiceResult<{ recoveryCodes: string[]; sessionVersion: number }>> {
  const now = ctx.now ?? new Date();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isActive) return { ok: false, message: "Conta inválida." };
  if (user.totpEnabledAt) return { ok: false, message: "O 2FA já está ativo nesta conta." };
  if (!user.totpPendingSecretEnc || !user.totpPendingAt || now.getTime() - user.totpPendingAt.getTime() >= MFA_PENDING_TTL_MS) {
    return { ok: false, message: "A configuração expirou. Gera um novo código." };
  }
  const ids = attemptIdentifiers(user.email, ctx.ip);
  const throttle = await checkAttemptThrottle(ids, now);
  if (!throttle.allowed) return BLOCKED(throttle.retryAfterMs);

  const secret = decryptSecret(user.totpPendingSecretEnc);
  const step = secret ? verifyTotp(secret, code, now) : null;
  if (step === null) {
    await prisma.loginAttempt.create({ data: { ...ids, success: false } });
    await audit(userId, "MFA_ENROLLMENT_FAILED", userId, ctx.ip);
    return { ok: false, message: "Código incorreto. Confirma a hora do telemóvel e tenta de novo." };
  }

  const recoveryCodes = generateRecoveryCodes();
  const result = await prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId, totpEnabledAt: null, totpPendingSecretEnc: user.totpPendingSecretEnc },
      data: {
        totpSecretEnc: user.totpPendingSecretEnc,
        totpEnabledAt: now,
        totpLastUsedStep: step,
        totpPendingSecretEnc: null,
        totpPendingAt: null,
        sessionVersion: { increment: 1 },
      },
    });
    if (count === 0) return null;
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.mfaRecoveryCode.createMany({ data: hashCodes(userId, recoveryCodes) });
    await tx.loginAttempt.create({ data: { ...ids, success: true } });
    await tx.auditLog.create({ data: { userId, action: "MFA_ENABLED", entityType: "User", entityId: userId, ipAddress: ctx.ip, metadataJson: {} } });
    return tx.user.findUniqueOrThrow({ where: { id: userId }, select: { sessionVersion: true } });
  });
  if (!result) return { ok: false, message: "A configuração mudou entretanto. Recarrega a página." };
  return { ok: true, value: { recoveryCodes, sessionVersion: result.sessionVersion } };
}

// ---------------------------------------------------------------------------
// Verificação do segundo fator
// ---------------------------------------------------------------------------

type VerifyOutcome = { ok: true; method: "totp" | "recovery"; recoveryCodesRemaining: number } | { ok: false; message: string };

/**
 * Valida um código TOTP (sem reutilização) ou um código de recuperação (uso único), com o
 * mesmo bloqueio por tentativas do login. As falhas contam para o bloqueio.
 */
async function verifySecondFactor(
  user: { id: string; email: string; totpSecretEnc: string | null; totpLastUsedStep: number | null },
  code: string,
  ctx: Context,
  options: { allowRecovery: boolean },
): Promise<VerifyOutcome> {
  const now = ctx.now ?? new Date();
  const ids = attemptIdentifiers(user.email, ctx.ip);
  const throttle = await checkAttemptThrottle(ids, now);
  if (!throttle.allowed) return BLOCKED(throttle.retryAfterMs);

  let method: "totp" | "recovery" | null = null;
  const secret = user.totpSecretEnc ? decryptSecret(user.totpSecretEnc) : null;
  const step = secret ? verifyTotp(secret, code, now, user.totpLastUsedStep) : null;
  if (step !== null) {
    // CAS: dois pedidos simultâneos com o mesmo código não passam ambos.
    const { count } = await prisma.user.updateMany({
      where: { id: user.id, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] },
      data: { totpLastUsedStep: step },
    });
    if (count === 1) method = "totp";
  } else if (options.allowRecovery) {
    const normalized = normalizeRecoveryCode(code);
    if (normalized) {
      const { count } = await prisma.mfaRecoveryCode.updateMany({
        where: { userId: user.id, codeHash: hashRecoveryCode(user.id, normalized), usedAt: null },
        data: { usedAt: now },
      });
      if (count === 1) method = "recovery";
    }
  }

  await prisma.loginAttempt.create({ data: { ...ids, success: method !== null } });
  if (!method) return INVALID_CODE;
  const recoveryCodesRemaining = await prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: null } });
  return { ok: true, method, recoveryCodesRemaining };
}

export type MfaLoginUser = {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  sessionVersion: number;
  mustChangePassword: boolean;
};

/** Segundo passo do login. `pending` vem do cookie assinado emitido após a palavra-passe. */
export async function completeMfaLogin(
  pending: { userId: string; sessionVersion: number },
  code: string,
  ctx: Context,
): Promise<ServiceResult<{ user: MfaLoginUser; method: "totp" | "recovery"; recoveryCodesRemaining: number }>> {
  const now = ctx.now ?? new Date();
  const user = await prisma.user.findUnique({ where: { id: pending.userId } });
  // Conta desativada, palavra-passe reposta ou 2FA reposto entretanto: recomeçar o login.
  if (!user?.isActive || user.sessionVersion !== pending.sessionVersion || !user.totpEnabledAt) {
    return { ok: false, message: "O início de sessão expirou. Introduz novamente a palavra-passe." };
  }
  const verified = await verifySecondFactor(user, code, { ...ctx, now }, { allowRecovery: true });
  if (!verified.ok) {
    await audit(user.id, "LOGIN_MFA_FAILED", user.id, ctx.ip);
    return verified;
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
    prisma.auditLog.create({
      data: { userId: user.id, action: "LOGIN_SUCCEEDED", entityType: "User", entityId: user.id, ipAddress: ctx.ip, metadataJson: { mfa: verified.method } },
    }),
    ...(verified.method === "recovery"
      ? [prisma.auditLog.create({ data: { userId: user.id, action: "MFA_RECOVERY_CODE_USED", entityType: "User", entityId: user.id, ipAddress: ctx.ip, metadataJson: { remaining: verified.recoveryCodesRemaining } } })]
      : []),
  ]);
  return {
    ok: true,
    value: {
      user: { id: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: user.sessionVersion, mustChangePassword: user.mustChangePassword },
      method: verified.method,
      recoveryCodesRemaining: verified.recoveryCodesRemaining,
    },
  };
}

// ---------------------------------------------------------------------------
// Gestão pelo próprio e reposição por um administrador
// ---------------------------------------------------------------------------

/** Novos códigos de recuperação (invalida os anteriores). Exige um código TOTP atual. */
export async function regenerateRecoveryCodes(userId: string, code: string, ctx: Context): Promise<ServiceResult<{ recoveryCodes: string[] }>> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isActive || !user.totpEnabledAt) return { ok: false, message: "O 2FA não está ativo." };
  const verified = await verifySecondFactor(user, code, ctx, { allowRecovery: false });
  if (!verified.ok) return verified;
  const recoveryCodes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    prisma.mfaRecoveryCode.createMany({ data: hashCodes(userId, recoveryCodes) }),
    prisma.auditLog.create({ data: { userId, action: "MFA_RECOVERY_CODES_REGENERATED", entityType: "User", entityId: userId, ipAddress: ctx.ip, metadataJson: {} } }),
  ]);
  return { ok: true, value: { recoveryCodes } };
}

/** Desativar o próprio 2FA: só perfis onde não é obrigatório; exige palavra-passe e código. */
export async function disableOwnMfa(
  userId: string,
  input: { password: string; code: string },
  ctx: Context,
): Promise<ServiceResult<{ sessionVersion: number }>> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isActive || !user.totpEnabledAt) return { ok: false, message: "O 2FA não está ativo." };
  if (mfaRequiredFor(user.role)) return { ok: false, message: "O 2FA é obrigatório para administradores." };
  if (!(await bcrypt.compare(input.password, user.passwordHash))) return { ok: false, message: "A palavra-passe está incorreta." };
  const verified = await verifySecondFactor(user, input.code, ctx, { allowRecovery: false });
  if (!verified.ok) return verified;
  const updated = await prisma.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.auditLog.create({ data: { userId, action: "MFA_DISABLED", entityType: "User", entityId: userId, ipAddress: ctx.ip, metadataJson: {} } });
    return tx.user.update({
      where: { id: userId },
      data: { totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null, sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });
  });
  return { ok: true, value: { sessionVersion: updated.sessionVersion } };
}

/**
 * Reposição por um administrador (telemóvel perdido): apaga o 2FA do utilizador e termina as
 * suas sessões. No próximo login, se o perfil o exigir, terá de o configurar de novo.
 */
export async function resetUserMfa(actor: Actor, userId: string, ctx: Context): Promise<ServiceResult> {
  if (!can(actor.role, "users:manage")) return { ok: false, message: "Só administradores podem repor o 2FA." };
  if (actor.id === userId) return { ok: false, message: "Não podes repor o teu próprio 2FA. Pede a outro administrador." };
  const done = await prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId, OR: [{ totpEnabledAt: { not: null } }, { totpPendingSecretEnc: { not: null } }] },
      data: {
        totpSecretEnc: null,
        totpEnabledAt: null,
        totpLastUsedStep: null,
        totpPendingSecretEnc: null,
        totpPendingAt: null,
        sessionVersion: { increment: 1 },
      },
    });
    if (count === 0) return false;
    await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
    await tx.auditLog.create({ data: { userId: actor.id, action: "USER_MFA_RESET", entityType: "User", entityId: userId, ipAddress: ctx.ip, metadataJson: {} } });
    return true;
  });
  return done ? { ok: true, value: undefined } : { ok: false, message: "Este utilizador não tem 2FA configurado." };
}
