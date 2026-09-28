import { ConsentStatus, Prisma } from "@/generated/prisma/client";
import {
  planConsentChange,
  resolveInitialConsent,
  type ConsentDetails,
  type ConsentStatusValue,
} from "@/features/contacts/consent";
import { can, type Role } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber, normalizePhoneNumber } from "@/lib/phone/normalize";

export type Actor = { id: string; role: Role };

export type ServiceResult<T = void> =
  | { ok: true; value: T; warning?: string }
  | { ok: false; message: string };

const NO_PERMISSION = { ok: false as const, message: "O teu perfil não permite esta ação." };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export type ContactInput = {
  name: string;
  phone: string;
  email?: string;
  notes?: string;
  consentStatus: ConsentStatusValue;
  consent: Partial<ConsentDetails>;
};

export async function createContact(
  actor: Actor,
  input: ContactInput,
): Promise<ServiceResult<{ id: string }>> {
  if (!can(actor.role, "contacts:write")) return NO_PERMISSION;

  let phoneE164: string;
  try {
    phoneE164 = normalizePhoneNumber(input.phone);
  } catch {
    return { ok: false, message: "Número de telefone inválido." };
  }

  const suppressed =
    (await prisma.suppressionEntry.findUnique({ where: { phoneE164 }, select: { id: true } })) !== null;
  const initial = resolveInitialConsent({ requested: input.consentStatus, details: input.consent, suppressed });
  if (!initial.ok) return initial;

  const now = new Date();
  try {
    const contact = await prisma.$transaction(async (tx) => {
      const created = await tx.contact.create({
        data: {
          name: input.name,
          phoneE164,
          email: input.email || null,
          notes: input.notes || null,
          consentStatus: initial.status,
          consentSource: initial.details?.source ?? null,
          consentAt: initial.status === "OPTED_IN" ? now : null,
          optedOutAt: initial.status === "OPTED_OUT" ? now : null,
        },
      });
      if (initial.details) {
        await tx.consentEvent.create({
          data: {
            contactId: created.id,
            status: initial.status,
            source: initial.details.source,
            purpose: initial.details.purpose,
            textVersion: initial.details.textVersion,
            process: "manual",
            recordedById: actor.id,
          },
        });
      }
      if (initial.status === "OPTED_OUT") {
        await tx.suppressionEntry.upsert({
          where: { phoneE164 },
          create: { phoneE164, source: "manual" },
          update: {},
        });
      }
      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: "CONTACT_CREATED",
          entityType: "Contact",
          entityId: created.id,
          metadataJson: { consentStatus: initial.status, destination: maskPhoneNumber(phoneE164) },
        },
      });
      return created;
    });
    return { ok: true, value: { id: contact.id }, warning: initial.warning };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, message: "Já existe um contacto com este número." };
    throw error;
  }
}

export async function updateContactDetails(
  actor: Actor,
  contactId: string,
  input: { name: string; email?: string; notes?: string },
): Promise<ServiceResult> {
  if (!can(actor.role, "contacts:write")) return NO_PERMISSION;
  const { count } = await prisma.contact.updateMany({
    where: { id: contactId },
    data: { name: input.name, email: input.email || null, notes: input.notes || null },
  });
  if (count === 0) return { ok: false, message: "Contacto não encontrado." };
  await prisma.auditLog.create({
    data: { userId: actor.id, action: "CONTACT_UPDATED", entityType: "Contact", entityId: contactId, metadataJson: {} },
  });
  return { ok: true, value: undefined };
}

export async function changeContactConsent(
  actor: Actor,
  contactId: string,
  to: "OPTED_IN" | "OPTED_OUT",
  details: Partial<ConsentDetails>,
): Promise<ServiceResult> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { id: true, phoneE164: true, consentStatus: true, optedOutAt: true },
  });
  if (!contact) return { ok: false, message: "Contacto não encontrado." };

  const suppressed =
    (await prisma.suppressionEntry.findUnique({ where: { phoneE164: contact.phoneE164 }, select: { id: true } })) !==
    null;
  const now = new Date();
  const plan = planConsentChange({
    current: { consentStatus: contact.consentStatus, optedOutAt: contact.optedOutAt, suppressed },
    to,
    details,
    role: actor.role,
    now,
  });
  if (!plan.ok) return plan;
  if (plan.noop) return { ok: true, value: undefined, warning: "O contacto já estava em opt-out." };

  const { change } = plan;
  await prisma.$transaction(async (tx) => {
    await tx.contact.update({
      where: { id: contactId },
      data: {
        consentStatus: change.status,
        consentSource: change.consentSource,
        consentAt: change.status === "OPTED_IN" ? change.consentAt : undefined,
        optedOutAt: change.optedOutAt,
      },
    });
    await tx.consentEvent.create({
      data: {
        contactId,
        status: change.status,
        source: change.details.source,
        purpose: change.details.purpose,
        textVersion: change.details.textVersion,
        process: "manual",
        recordedById: actor.id,
      },
    });
    if (change.suppression === "add") {
      await tx.suppressionEntry.upsert({
        where: { phoneE164: contact.phoneE164 },
        create: { phoneE164: contact.phoneE164, source: "manual" },
        update: {},
      });
    } else {
      await tx.suppressionEntry.deleteMany({ where: { phoneE164: contact.phoneE164 } });
    }
    await tx.auditLog.create({
      data: {
        userId: actor.id,
        action: change.status === "OPTED_OUT" ? "CONTACT_OPTED_OUT" : wasOptedOut(contact, suppressed) ? "CONTACT_REOPTED_IN" : "CONTACT_OPTED_IN",
        entityType: "Contact",
        entityId: contactId,
        metadataJson: {
          from: contact.consentStatus,
          to: change.status,
          source: change.details.source,
          purpose: change.details.purpose ?? null,
        },
      },
    });
  });
  return { ok: true, value: undefined };
}

function wasOptedOut(contact: { consentStatus: string; optedOutAt: Date | null }, suppressed: boolean) {
  return suppressed || contact.optedOutAt !== null || contact.consentStatus === ConsentStatus.OPTED_OUT;
}

/**
 * Elimina o contacto (RGPD). O histórico de mensagens mantém-se (sem ligação ao
 * contacto) e a suppression list NÃO é limpa: um número em opt-out continua bloqueado.
 */
export async function deleteContact(actor: Actor, contactId: string): Promise<ServiceResult> {
  if (!can(actor.role, "contacts:delete")) return NO_PERMISSION;
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { phoneE164: true, consentStatus: true },
  });
  if (!contact) return { ok: false, message: "Contacto não encontrado." };

  await prisma.$transaction([
    prisma.contact.delete({ where: { id: contactId } }),
    prisma.auditLog.create({
      data: {
        userId: actor.id,
        action: "CONTACT_DELETED",
        entityType: "Contact",
        entityId: contactId,
        metadataJson: { destination: maskPhoneNumber(contact.phoneE164), consentStatus: contact.consentStatus },
      },
    }),
  ]);
  return { ok: true, value: undefined };
}
