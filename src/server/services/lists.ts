import { Prisma } from "@/generated/prisma/client";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { normalizePhoneNumber } from "@/lib/phone/normalize";
import type { Actor, ServiceResult } from "./contacts";

const NO_PERMISSION = { ok: false as const, message: "O teu perfil não permite esta ação." };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createList(
  actor: Actor,
  input: { name: string; description?: string },
): Promise<ServiceResult<{ id: string }>> {
  if (!can(actor.role, "lists:write")) return NO_PERMISSION;
  try {
    const list = await prisma.contactList.create({
      data: { name: input.name, description: input.description || null },
    });
    await prisma.auditLog.create({
      data: { userId: actor.id, action: "LIST_CREATED", entityType: "ContactList", entityId: list.id, metadataJson: {} },
    });
    return { ok: true, value: { id: list.id } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, message: "Já existe uma lista com este nome." };
    throw error;
  }
}

export async function updateList(
  actor: Actor,
  listId: string,
  input: { name: string; description?: string },
): Promise<ServiceResult> {
  if (!can(actor.role, "lists:write")) return NO_PERMISSION;
  try {
    const { count } = await prisma.contactList.updateMany({
      where: { id: listId },
      data: { name: input.name, description: input.description || null },
    });
    if (count === 0) return { ok: false, message: "Lista não encontrada." };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, message: "Já existe uma lista com este nome." };
    throw error;
  }
  await prisma.auditLog.create({
    data: { userId: actor.id, action: "LIST_UPDATED", entityType: "ContactList", entityId: listId, metadataJson: {} },
  });
  return { ok: true, value: undefined };
}

/** Elimina a lista e as associações; os contactos não são afetados. */
export async function deleteList(actor: Actor, listId: string): Promise<ServiceResult> {
  if (!can(actor.role, "lists:delete")) return NO_PERMISSION;
  const { count } = await prisma.contactList.deleteMany({ where: { id: listId } });
  if (count === 0) return { ok: false, message: "Lista não encontrada." };
  await prisma.auditLog.create({
    data: { userId: actor.id, action: "LIST_DELETED", entityType: "ContactList", entityId: listId, metadataJson: {} },
  });
  return { ok: true, value: undefined };
}

export async function addContactToList(actor: Actor, listId: string, contactId: string): Promise<ServiceResult> {
  if (!can(actor.role, "lists:write")) return NO_PERMISSION;
  const [list, contact] = await Promise.all([
    prisma.contactList.findUnique({ where: { id: listId }, select: { id: true } }),
    prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } }),
  ]);
  if (!list) return { ok: false, message: "Lista não encontrada." };
  if (!contact) return { ok: false, message: "Contacto não encontrado." };

  const { count } = await prisma.contactListMember.createMany({
    data: [{ listId, contactId }],
    skipDuplicates: true,
  });
  if (count === 0) return { ok: true, value: undefined, warning: "O contacto já pertencia à lista." };
  await prisma.auditLog.create({
    data: {
      userId: actor.id,
      action: "LIST_MEMBER_ADDED",
      entityType: "ContactList",
      entityId: listId,
      metadataJson: { contactId },
    },
  });
  return { ok: true, value: undefined };
}

export async function addContactToListByPhone(actor: Actor, listId: string, phone: string): Promise<ServiceResult> {
  let phoneE164: string;
  try {
    phoneE164 = normalizePhoneNumber(phone);
  } catch {
    return { ok: false, message: "Número de telefone inválido." };
  }
  const contact = await prisma.contact.findUnique({ where: { phoneE164 }, select: { id: true } });
  if (!contact) return { ok: false, message: "Não existe contacto com este número. Cria-o primeiro." };
  return addContactToList(actor, listId, contact.id);
}

export async function removeContactFromList(actor: Actor, listId: string, contactId: string): Promise<ServiceResult> {
  if (!can(actor.role, "lists:write")) return NO_PERMISSION;
  const { count } = await prisma.contactListMember.deleteMany({ where: { listId, contactId } });
  if (count === 0) return { ok: false, message: "O contacto não pertence à lista." };
  await prisma.auditLog.create({
    data: {
      userId: actor.id,
      action: "LIST_MEMBER_REMOVED",
      entityType: "ContactList",
      entityId: listId,
      metadataJson: { contactId },
    },
  });
  return { ok: true, value: undefined };
}

/** Contagens de elegibilidade por lista (base para campanhas). */
export async function getListEligibility(listId: string) {
  const where = { lists: { some: { listId } } };
  const [total, optedIn, optedOut] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.count({ where: { ...where, consentStatus: "OPTED_IN", optedOutAt: null } }),
    prisma.contact.count({ where: { ...where, OR: [{ consentStatus: "OPTED_OUT" }, { optedOutAt: { not: null } }] } }),
  ]);
  return { total, optedIn, optedOut, withoutConsent: total - optedIn - optedOut };
}
