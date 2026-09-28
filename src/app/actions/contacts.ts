"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { ConsentStatus } from "@/generated/prisma/client";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { normalizePhoneNumber } from "@/lib/phone/normalize";

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().min(6).max(40),
  consentStatus: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]),
  consentSource: z.string().trim().max(120).optional(),
});

export async function createContactAction(formData: FormData) {
  const user = await requireUser();
  if (user.role === "VIEWER") redirect("/contacts?error=Sem%20permiss%C3%A3o");

  const parsed = schema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
    consentStatus: formData.get("consentStatus"),
    consentSource: String(formData.get("consentSource") ?? "") || undefined,
  });
  if (!parsed.success) redirect("/contacts?error=Dados%20inv%C3%A1lidos");

  let phoneE164: string;
  try {
    phoneE164 = normalizePhoneNumber(parsed.data.phone);
  } catch {
    redirect("/contacts?error=N%C3%BAmero%20inv%C3%A1lido");
  }

  const status = ConsentStatus[parsed.data.consentStatus];
  try {
    const contact = await prisma.contact.create({
      data: {
        name: parsed.data.name,
        phoneE164,
        consentStatus: status,
        consentSource: parsed.data.consentSource,
        consentAt: status === ConsentStatus.OPTED_IN ? new Date() : null,
        optedOutAt: status === ConsentStatus.OPTED_OUT ? new Date() : null,
      },
    });
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "CONTACT_CREATED",
        entityType: "Contact",
        entityId: contact.id,
        metadataJson: { consentStatus: status },
      },
    });
  } catch {
    redirect("/contacts?error=N%C3%A3o%20foi%20poss%C3%ADvel%20criar%20o%20contacto%20(poss%C3%ADvel%20duplicado)");
  }

  redirect("/contacts?success=Contacto%20criado");
}
