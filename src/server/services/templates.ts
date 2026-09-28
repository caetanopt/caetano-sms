import { Prisma } from "@/generated/prisma/client";
import { checkTemplateBody } from "@/features/templates/template-rules";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db/prisma";
import type { SmsMessageType } from "@/lib/sms/types";
import type { Actor, ServiceResult } from "./contacts";

const NO_PERMISSION = { ok: false as const, message: "O teu perfil não permite gerir templates." };

export type TemplateInput = { name: string; body: string; messageType: SmsMessageType };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function validate(input: TemplateInput): string | null {
  const check = checkTemplateBody(input.body);
  return check.ok ? null : check.errors.join(" ");
}

export async function createTemplate(actor: Actor, input: TemplateInput): Promise<ServiceResult<{ id: string }>> {
  if (!can(actor.role, "templates:write")) return NO_PERMISSION;
  const error = validate(input);
  if (error) return { ok: false, message: error };
  try {
    const template = await prisma.$transaction(async (tx) => {
      const created = await tx.smsTemplate.create({ data: { ...input, createdById: actor.id } });
      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: "TEMPLATE_CREATED",
          entityType: "SmsTemplate",
          entityId: created.id,
          metadataJson: { name: input.name, messageType: input.messageType },
        },
      });
      return created;
    });
    return { ok: true, value: { id: template.id } };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, message: "Já existe um template com este nome." };
    throw err;
  }
}

export async function updateTemplate(actor: Actor, templateId: string, input: TemplateInput): Promise<ServiceResult> {
  if (!can(actor.role, "templates:write")) return NO_PERMISSION;
  const error = validate(input);
  if (error) return { ok: false, message: error };
  const existing = await prisma.smsTemplate.findUnique({ where: { id: templateId }, select: { messageType: true } });
  if (!existing) return { ok: false, message: "Template não encontrado." };
  try {
    await prisma.$transaction([
      prisma.smsTemplate.update({ where: { id: templateId }, data: input }),
      prisma.auditLog.create({
        data: {
          userId: actor.id,
          action: "TEMPLATE_UPDATED",
          entityType: "SmsTemplate",
          entityId: templateId,
          metadataJson: {
            name: input.name,
            messageType: input.messageType,
            messageTypeChanged: existing.messageType !== input.messageType,
          },
        },
      }),
    ]);
    return { ok: true, value: undefined };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, message: "Já existe um template com este nome." };
    throw err;
  }
}

/** As mensagens já enviadas mantêm o texto; apenas perdem a ligação ao template. */
export async function deleteTemplate(actor: Actor, templateId: string): Promise<ServiceResult> {
  if (!can(actor.role, "templates:write")) return NO_PERMISSION;
  const template = await prisma.smsTemplate.findUnique({ where: { id: templateId }, select: { name: true } });
  if (!template) return { ok: false, message: "Template não encontrado." };
  await prisma.$transaction([
    prisma.smsTemplate.delete({ where: { id: templateId } }),
    prisma.auditLog.create({
      data: {
        userId: actor.id,
        action: "TEMPLATE_DELETED",
        entityType: "SmsTemplate",
        entityId: templateId,
        metadataJson: { name: template.name },
      },
    }),
  ]);
  return { ok: true, value: undefined };
}
