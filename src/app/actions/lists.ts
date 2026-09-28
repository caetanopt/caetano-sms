"use server";

import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { redirectWith } from "@/lib/http/redirect-with";
import {
  addContactToList,
  addContactToListByPhone,
  createList,
  deleteList,
  removeContactFromList,
  updateList,
} from "@/server/services/lists";

const listSchema = z.object({
  name: z.string().trim().min(1, "Indica o nome da lista.").max(120),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((value) => value || undefined),
});

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

const listPath = (listId: string) => `/lists/${encodeURIComponent(listId)}`;

export async function createListAction(formData: FormData) {
  const user = await requireUser();
  const parsed = listSchema.safeParse({ name: text(formData, "name"), description: text(formData, "description") });
  if (!parsed.success) redirectWith("/lists", { error: parsed.error.issues[0].message });
  const result = await createList(user, parsed.data);
  if (!result.ok) redirectWith("/lists", { error: result.message });
  redirectWith(listPath(result.value.id), { success: "Lista criada." });
}

export async function updateListAction(listId: string, formData: FormData) {
  const user = await requireUser();
  const parsed = listSchema.safeParse({ name: text(formData, "name"), description: text(formData, "description") });
  if (!parsed.success) redirectWith(listPath(listId), { error: parsed.error.issues[0].message });
  const result = await updateList(user, listId, parsed.data);
  if (!result.ok) redirectWith(listPath(listId), { error: result.message });
  redirectWith(listPath(listId), { success: "Lista atualizada." });
}

export async function deleteListAction(listId: string, formData: FormData) {
  const user = await requireUser();
  if (text(formData, "confirm") !== "on") {
    redirectWith(listPath(listId), { error: "Confirma a eliminação assinalando a caixa." });
  }
  const result = await deleteList(user, listId);
  if (!result.ok) redirectWith(listPath(listId), { error: result.message });
  redirectWith("/lists", { success: "Lista eliminada. Os contactos não foram afetados." });
}

export async function addMemberByPhoneAction(listId: string, formData: FormData) {
  const user = await requireUser();
  const phone = text(formData, "phone")?.trim() ?? "";
  if (phone.length < 6 || phone.length > 40) redirectWith(listPath(listId), { error: "Número de telefone inválido." });
  const result = await addContactToListByPhone(user, listId, phone);
  if (!result.ok) redirectWith(listPath(listId), { error: result.message });
  redirectWith(listPath(listId), { success: result.warning ?? "Contacto adicionado à lista." });
}

/** Adicionar a partir da página do contacto. */
export async function addContactToListAction(contactId: string, formData: FormData) {
  const user = await requireUser();
  const path = `/contacts/${encodeURIComponent(contactId)}`;
  const listId = text(formData, "listId");
  if (!listId) redirectWith(path, { error: "Seleciona uma lista." });
  const result = await addContactToList(user, listId, contactId);
  if (!result.ok) redirectWith(path, { error: result.message });
  redirectWith(path, { success: result.warning ?? "Contacto adicionado à lista." });
}

export async function removeMemberAction(listId: string, contactId: string, formData: FormData) {
  const user = await requireUser();
  const back = text(formData, "back") === "contact" ? `/contacts/${encodeURIComponent(contactId)}` : listPath(listId);
  const result = await removeContactFromList(user, listId, contactId);
  if (!result.ok) redirectWith(back, { error: result.message });
  redirectWith(back, { success: "Contacto removido da lista." });
}
