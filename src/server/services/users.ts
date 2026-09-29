import bcrypt from "bcryptjs";
import { Prisma } from "@/generated/prisma/client";
import { checkPasswordPolicy, generateTemporaryPassword } from "@/features/auth/password-policy";
import { can, type Role } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import type { Actor, ServiceResult } from "./contacts";

const BCRYPT_COST = 12;
const NO_PERMISSION = { ok: false as const, message: "Só administradores podem gerir utilizadores." };
const CONCURRENT = { ok: false as const, message: "Outra alteração ocorreu ao mesmo tempo. Tenta de novo." };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
function isSerializationFailure(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

async function audit(tx: Prisma.TransactionClient, actorId: string, action: string, userId: string, metadata: Record<string, string | boolean | null> = {}) {
  await tx.auditLog.create({ data: { userId: actorId, action, entityType: "User", entityId: userId, metadataJson: metadata } });
}

export async function createUser(
  actor: Actor,
  input: { name: string; email: string; role: Role },
): Promise<ServiceResult<{ id: string; temporaryPassword: string }>> {
  if (!can(actor.role, "users:manage")) return NO_PERMISSION;
  const temporaryPassword = generateTemporaryPassword();
  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: input.name,
          email: input.email.trim().toLowerCase(),
          role: input.role,
          passwordHash: await bcrypt.hash(temporaryPassword, BCRYPT_COST),
          mustChangePassword: true,
        },
      });
      await audit(tx, actor.id, "USER_CREATED", created.id, { role: input.role });
      return created;
    });
    return { ok: true, value: { id: user.id, temporaryPassword } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, message: "Já existe um utilizador com este email." };
    throw error;
  }
}

/**
 * Altera nome/perfil/estado. Salvaguardas: ninguém altera o próprio perfil nem se desativa,
 * e nunca fica zero administradores ativos (transação serializável contra corridas).
 * Mudar perfil ou desativar invalida as sessões abertas do utilizador.
 */
export async function updateUser(
  actor: Actor,
  userId: string,
  input: { name: string; role: Role; isActive: boolean },
): Promise<ServiceResult> {
  if (!can(actor.role, "users:manage")) return NO_PERMISSION;
  try {
    return await prisma.$transaction(
      async (tx) => {
        const target = await tx.user.findUnique({ where: { id: userId } });
        if (!target) return { ok: false as const, message: "Utilizador não encontrado." };

        const roleChanged = target.role !== input.role;
        const activeChanged = target.isActive !== input.isActive;
        if (userId === actor.id && (roleChanged || !input.isActive)) {
          return { ok: false as const, message: "Não podes alterar o teu próprio perfil nem desativar a tua conta." };
        }
        const losesAdmin = target.role === "ADMIN" && target.isActive && (input.role !== "ADMIN" || !input.isActive);
        if (losesAdmin) {
          const admins = await tx.user.count({ where: { role: "ADMIN", isActive: true } });
          if (admins <= 1) return { ok: false as const, message: "Tem de existir pelo menos um administrador ativo." };
        }

        await tx.user.update({
          where: { id: userId },
          data: {
            name: input.name,
            role: input.role,
            isActive: input.isActive,
            sessionVersion: roleChanged || activeChanged ? { increment: 1 } : undefined,
          },
        });
        if (roleChanged) await audit(tx, actor.id, "USER_ROLE_CHANGED", userId, { from: target.role, to: input.role });
        if (activeChanged) await audit(tx, actor.id, input.isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED", userId);
        if (target.name !== input.name) await audit(tx, actor.id, "USER_UPDATED", userId);
        return { ok: true as const, value: undefined };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (isSerializationFailure(error)) return CONCURRENT;
    throw error;
  }
}

/** Nova palavra-passe temporária; termina as sessões abertas e obriga a trocar no login. */
export async function resetUserPassword(
  actor: Actor,
  userId: string,
): Promise<ServiceResult<{ temporaryPassword: string }>> {
  if (!can(actor.role, "users:manage")) return NO_PERMISSION;
  if (userId === actor.id) return { ok: false, message: "Para a tua conta usa “Alterar palavra-passe”." };
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_COST);
  const done = await prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: true, sessionVersion: { increment: 1 }, passwordChangedAt: new Date() },
    });
    if (count === 0) return false;
    await audit(tx, actor.id, "USER_PASSWORD_RESET", userId);
    return true;
  });
  if (!done) return { ok: false, message: "Utilizador não encontrado." };
  return { ok: true, value: { temporaryPassword } };
}

/** O próprio utilizador altera a palavra-passe (exige a atual). Devolve a nova versão de sessão. */
export async function changeOwnPassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<ServiceResult<{ sessionVersion: number }>> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isActive) return { ok: false, message: "Conta inválida." };
  if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
    await prisma.auditLog.create({
      data: { userId, action: "PASSWORD_CHANGE_FAILED", entityType: "User", entityId: userId, metadataJson: {} },
    });
    return { ok: false, message: "A palavra-passe atual está incorreta." };
  }
  const policy = checkPasswordPolicy(input.newPassword, { email: user.email, name: user.name });
  if (policy) return { ok: false, message: policy };
  if (await bcrypt.compare(input.newPassword, user.passwordHash)) {
    return { ok: false, message: "A nova palavra-passe tem de ser diferente da atual." };
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(input.newPassword, BCRYPT_COST),
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        sessionVersion: { increment: 1 },
      },
      select: { sessionVersion: true },
    });
    await audit(tx, userId, "PASSWORD_CHANGED", userId);
    return row;
  });
  return { ok: true, value: { sessionVersion: updated.sessionVersion } };
}
