"use server";

import { parseImportFormData } from "@/features/contacts/import-request";
import type { ImportFormState } from "@/features/contacts/import-state";
import { requireUser } from "@/lib/auth/session";
import { commitImport, previewImport } from "@/server/services/contact-import";

export async function importContactsAction(
  _previous: ImportFormState,
  formData: FormData,
): Promise<ImportFormState> {
  const user = await requireUser();
  const request = parseImportFormData(formData);
  if (!request) return { step: "edit", error: "Pedido inválido. Volta a carregar o ficheiro." };

  const intent = formData.get("intent");
  if (intent === "preview") {
    const result = await previewImport(user, request);
    if (!result.ok) return { step: "edit", error: result.message };
    return { step: "preview", preview: result.value };
  }

  if (intent === "commit") {
    const result = await commitImport(user, request);
    if (!result.ok) return { step: "edit", error: result.message };
    return { step: "done", report: result.value };
  }

  return { step: "edit", error: "Pedido inválido." };
}
