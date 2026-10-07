"use server";

import { z } from "zod";
import type { TemplateFormState } from "@/features/templates/template-form-state";
import { requireUser } from "@/lib/auth/session";
import { redirectWith } from "@/lib/http/redirect-with";
import { createTemplate, deleteTemplate, updateTemplate } from "@/server/services/templates";

const schema = z.object({
  name: z.string().trim().min(1, "Indica o nome do template.").max(120),
  body: z.string().min(1, "O texto do template está vazio.").max(1530, "Texto demasiado longo."),
  messageType: z.enum(["TRANSACTIONAL", "PROMOTIONAL"], { error: "Seleciona o tipo de mensagem." }),
});

export async function saveTemplateAction(
  _previous: TemplateFormState,
  formData: FormData,
): Promise<TemplateFormState> {
  const user = await requireUser();
  const parsed = schema.safeParse({
    name: formData.get("name"),
    body: formData.get("body"),
    messageType: formData.get("messageType"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

  const templateId = formData.get("templateId");
  if (typeof templateId === "string" && templateId !== "") {
    const result = await updateTemplate(user, templateId, parsed.data);
    if (!result.ok) return { error: result.message };
    return redirectWith(`/templates/${encodeURIComponent(templateId)}`, { success: "Template atualizado." });
  }

  const result = await createTemplate(user, parsed.data);
  if (!result.ok) return { error: result.message };
  return redirectWith(`/templates/${encodeURIComponent(result.value.id)}`, { success: "Template criado." });
}

export async function deleteTemplateAction(templateId: string, formData: FormData) {
  const user = await requireUser();
  const path = `/templates/${encodeURIComponent(templateId)}`;
  if (formData.get("confirm") !== "on") return redirectWith(path, { error: "Confirma a eliminação assinalando a caixa." });
  const result = await deleteTemplate(user, templateId);
  if (!result.ok) return redirectWith(path, { error: result.message });
  return redirectWith("/templates", { success: "Template eliminado. As mensagens já enviadas mantêm o texto." });
}
