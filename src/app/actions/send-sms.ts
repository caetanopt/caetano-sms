"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { MessageType, SmsMessageStatus } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { maskPhoneNumber, normalizePhoneNumber } from "@/lib/phone/normalize";
import { assertSmsLength } from "@/lib/sms/encoding";
import { checkManualSendEligibility } from "@/lib/sms/eligibility";
import { getSmsProvider } from "@/lib/sms/provider";
import type { SmsProvider } from "@/lib/sms/types";

const schema = z.object({
  requestId: z.string().uuid(),
  phone: z.string().min(6).max(40),
  message: z.string().min(1).max(1530),
  messageType: z.enum(["TRANSACTIONAL", "PROMOTIONAL"]),
  legalBasis: z.boolean(),
});

function fail(message: string): never {
  redirect(`/send?error=${encodeURIComponent(message)}`);
}

export async function sendSmsAction(formData: FormData) {
  const user = await requireUser();
  if (user.role === "VIEWER") fail("O teu perfil não permite enviar SMS.");

  const parsed = schema.safeParse({
    requestId: formData.get("requestId"),
    phone: formData.get("phone"),
    message: formData.get("message"),
    messageType: formData.get("messageType"),
    legalBasis: formData.get("legalBasis") === "on",
  });
  if (!parsed.success) fail("Revê os dados do formulário.");

  let phoneE164: string;
  try {
    phoneE164 = normalizePhoneNumber(parsed.data.phone);
  } catch {
    fail("Número de telefone inválido.");
  }

  let segmentInfo;
  try {
    segmentInfo = assertSmsLength(parsed.data.message);
  } catch (error) {
    fail(error instanceof Error ? error.message : "Mensagem inválida.");
  }

  const contact = await prisma.contact.findUnique({ where: { phoneE164 } });
  const eligibility = checkManualSendEligibility({
    contact,
    messageType: parsed.data.messageType,
    legalBasisConfirmed: parsed.data.legalBasis,
  });
  if (!eligibility.ok) fail(eligibility.message);

  const existing = await prisma.smsMessage.findUnique({
    where: { idempotencyKey: parsed.data.requestId },
  });
  if (existing) {
    redirect(`/send?success=${encodeURIComponent("Este pedido já foi processado; não foi enviado novamente.")}`);
  }

  // Resolver o provider antes de criar o registo: um erro de configuração não deve
  // deixar uma mensagem PENDING órfã.
  let provider: SmsProvider;
  try {
    provider = getSmsProvider();
  } catch {
    fail("O serviço de envio não está configurado corretamente.");
  }

  const providerName = process.env.SMS_PROVIDER ?? "fake";
  let message: { id: string };
  try {
    message = await prisma.smsMessage.create({
      data: {
        idempotencyKey: parsed.data.requestId,
        contactId: contact?.id,
        destinationPhoneE164: phoneE164,
        messageType:
          parsed.data.messageType === "PROMOTIONAL"
            ? MessageType.PROMOTIONAL
            : MessageType.TRANSACTIONAL,
        body: parsed.data.message,
        encodingEstimate: segmentInfo.encoding,
        segmentCountEstimate: segmentInfo.segments,
        status: SmsMessageStatus.PENDING,
        provider: providerName,
        createdById: user.id,
      },
    });
  } catch {
    const raced = await prisma.smsMessage.findUnique({
      where: { idempotencyKey: parsed.data.requestId },
    });
    if (raced) {
      redirect(`/send?success=${encodeURIComponent("Este pedido já foi processado; não foi enviado novamente.")}`);
    }
    fail("Não foi possível registar o pedido de envio.");
  }

  const result = await provider.send({
    destinationPhoneNumber: phoneE164,
    messageBody: parsed.data.message,
    messageType: parsed.data.messageType,
    dryRun: process.env.AWS_SMS_DRY_RUN !== "false",
    context: { internalMessageId: message.id, source: "manual" },
  });

  if (result.ok) {
    await prisma.$transaction([
      prisma.smsMessage.update({
        where: { id: message.id },
        data: {
          awsMessageId: result.messageId,
          status: SmsMessageStatus.ACCEPTED,
          sentAt: new Date(),
          provider: result.provider,
        },
      }),
      prisma.auditLog.create({
        data: {
          userId: user.id,
          action: "SMS_SEND_ACCEPTED",
          entityType: "SmsMessage",
          entityId: message.id,
          metadataJson: {
            destination: maskPhoneNumber(phoneE164),
            provider: result.provider,
            messageType: parsed.data.messageType,
            segments: segmentInfo.segments,
            legalBasisConfirmed: parsed.data.legalBasis,
          },
        },
      }),
    ]);
    redirect(`/send?success=${encodeURIComponent(`Mensagem aceite (${result.messageId}).`)}`);
  }

  await prisma.$transaction([
    prisma.smsMessage.update({
      where: { id: message.id },
      data: {
        status: SmsMessageStatus.FAILED,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        failedAt: new Date(),
      },
    }),
    prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "SMS_SEND_FAILED",
        entityType: "SmsMessage",
        entityId: message.id,
        metadataJson: {
          destination: maskPhoneNumber(phoneE164),
          errorCode: result.errorCode,
        },
      },
    }),
  ]);

  fail(result.errorMessage);
}
