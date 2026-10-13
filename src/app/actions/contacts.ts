"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { redirectWith } from "@/lib/http/redirect-with";
import {
  changeContactConsent,
  createContact,
  deleteContact,
  updateContactDetails,
} from "@/server/services/contacts";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || undefined);

const detailsSchema = z.object({
  name: z.string().trim().min(1, "Indica o nome.").max(120),
  email: z
    .union([z.literal(""), z.email("Email inválido.")])
    .optional()
    .transform((value) => value?.toLowerCase() || undefined),
  notes: optionalText(1000),
});

const consentDetailsSchema = z.object({
  consentSource: optionalText(120),
  consentPurpose: optionalText(120),
  consentTextVersion: optionalText(200),
});

const createSchema = detailsSchema.extend(consentDetailsSchema.shape).extend({
  phone: z.string().trim().min(6, "Número de telefone inválido.").max(40),
  consentStatus: z.enum(["UNKNOWN", "OPTED_IN", "OPTED_OUT"]),
});

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function firstIssue(error: z.ZodError) {
  return error.issues[0]?.message ?? "Dados inválidos.";
}

export async function createContactAction(formData: FormData) {
  const user = await requireUser();
  const parsed = createSchema.safeParse({
    name: text(formData, "name"),
    phone: text(formData, "phone"),
    email: text(formData, "email"),
    notes: text(formData, "notes"),
    consentStatus: text(formData, "consentStatus"),
    consentSource: text(formData, "consentSource"),
    consentPurpose: text(formData, "consentPurpose"),
    consentTextVersion: text(formData, "consentTextVersion"),
  });
  if (!parsed.success) return redirectWith("/contacts", { error: firstIssue(parsed.error) });

  const result = await createContact(user, {
    name: parsed.data.name,
    phone: parsed.data.phone,
    email: parsed.data.email,
    notes: parsed.data.notes,
    consentStatus: parsed.data.consentStatus,
    consent: {
      source: parsed.data.consentSource,
      purpose: parsed.data.consentPurpose,
      textVersion: parsed.data.consentTextVersion,
    },
  });
  if (!result.ok) return redirectWith("/contacts", { error: result.message });
  return redirectWith(`/contacts/${result.value.id}`, {
    success: result.warning ? `Contacto criado. ${result.warning}` : "Contacto criado.",
  });
}

export async function updateContactAction(contactId: string, formData: FormData) {
  const user = await requireUser();
  const path = `/contacts/${encodeURIComponent(contactId)}`;
  const parsed = detailsSchema.safeParse({
    name: text(formData, "name"),
    email: text(formData, "email"),
    notes: text(formData, "notes"),
  });
  if (!parsed.success) return redirectWith(path, { error: firstIssue(parsed.error) });

  const result = await updateContactDetails(user, contactId, parsed.data);
  if (!result.ok) return redirectWith(path, { error: result.message });
  return redirectWith(path, { success: "Contacto atualizado." });
}

export async function changeConsentAction(contactId: string, formData: FormData) {
  const user = await requireUser();
  const path = `/contacts/${encodeURIComponent(contactId)}`;
  const to = text(formData, "to");
  if (to !== "OPTED_IN" && to !== "OPTED_OUT") return redirectWith(path, { error: "Pedido inválido." });

  const parsed = consentDetailsSchema.safeParse({
    consentSource: text(formData, "consentSource"),
    consentPurpose: text(formData, "consentPurpose"),
    consentTextVersion: text(formData, "consentTextVersion"),
  });
  if (!parsed.success) return redirectWith(path, { error: firstIssue(parsed.error) });

  const result = await changeContactConsent(user, contactId, to, {
    source: parsed.data.consentSource,
    purpose: parsed.data.consentPurpose,
    textVersion: parsed.data.consentTextVersion,
  });
  if (!result.ok) return redirectWith(path, { error: result.message });
  return redirectWith(path, {
    success: result.warning ?? (to === "OPTED_OUT" ? "Opt-out registado." : "Opt-in registado."),
  });
}

export async function deleteContactAction(contactId: string, formData: FormData) {
  const user = await requireUser();
  const path = `/contacts/${encodeURIComponent(contactId)}`;
  if (text(formData, "confirm") !== "on") {
    return redirectWith(path, { error: "Confirma a eliminação assinalando a caixa." });
  }
  const result = await deleteContact(user, contactId);
  if (!result.ok) return redirectWith(path, { error: result.message });
  return redirectWith("/contacts", { success: "Contacto eliminado. O histórico de mensagens e a suppression list mantêm-se." });
}
