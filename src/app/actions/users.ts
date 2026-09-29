"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "@/features/auth/password-policy";
import type { PasswordChangeFormState, UserSecretFormState } from "@/features/users/user-form-state";
import { can } from "@/lib/auth/permissions";
import { createSession, requireUser } from "@/lib/auth/session";
import { redirectWith } from "@/lib/http/redirect-with";
import { changeOwnPassword, createUser, resetUserPassword, updateUser } from "@/server/services/users";

const role = z.enum(["ADMIN", "OPERATOR", "VIEWER"], { error: "Seleciona o perfil." });
const name = z.string().trim().min(1, "Indica o nome.").max(120, "Nome demasiado longo.");

const createSchema = z.object({ name, email: z.email("Email inválido.").max(200), role });
const updateSchema = z.object({ name, role, isActive: z.enum(["true", "false"], { error: "Estado inválido." }) });
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Indica a palavra-passe atual.").max(MAX_PASSWORD_LENGTH),
    newPassword: z.string().max(MAX_PASSWORD_LENGTH, "Palavra-passe demasiado longa."),
    confirmPassword: z.string().max(MAX_PASSWORD_LENGTH),
  })
  .refine((v) => v.newPassword === v.confirmPassword, { message: "A confirmação não coincide com a nova palavra-passe." });

/** Só ADMIN; a role vem sempre da base de dados (requireUser). */
async function requireAdmin() {
  const user = await requireUser();
  if (!can(user.role, "users:manage")) redirectWith("/dashboard", { error: "Sem permissão para gerir utilizadores." });
  return user;
}

export async function createUserAction(_previous: UserSecretFormState, formData: FormData): Promise<UserSecretFormState> {
  const admin = await requireAdmin();
  const raw = { name: String(formData.get("name") ?? ""), email: String(formData.get("email") ?? ""), role: String(formData.get("role") ?? "") };
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos.", values: raw };
  const result = await createUser(admin, parsed.data);
  if (!result.ok) return { error: result.message, values: raw };
  revalidatePath("/users");
  return { temporaryPassword: result.value.temporaryPassword, email: parsed.data.email.trim().toLowerCase() };
}

export async function updateUserAction(userId: string, formData: FormData) {
  const admin = await requireAdmin();
  const path = `/users/${encodeURIComponent(userId)}`;
  const parsed = updateSchema.safeParse({ name: formData.get("name"), role: formData.get("role"), isActive: formData.get("isActive") });
  if (!parsed.success) redirectWith(path, { error: parsed.error.issues[0]?.message ?? "Dados inválidos." });
  const result = await updateUser(admin, userId, { ...parsed.data, isActive: parsed.data.isActive === "true" });
  if (!result.ok) redirectWith(path, { error: result.message });
  redirectWith(path, { success: "Utilizador atualizado." });
}

export async function resetPasswordAction(userId: string, _previous: UserSecretFormState, formData: FormData): Promise<UserSecretFormState> {
  const admin = await requireAdmin();
  if (formData.get("confirm") !== "on") return { error: "Confirma a reposição assinalando a caixa." };
  const result = await resetUserPassword(admin, userId);
  if (!result.ok) return { error: result.message };
  revalidatePath(`/users/${userId}`);
  return { temporaryPassword: result.value.temporaryPassword };
}

export async function changePasswordAction(_previous: PasswordChangeFormState, formData: FormData): Promise<PasswordChangeFormState> {
  const user = await requireUser({ allowPasswordChange: true });
  const parsed = passwordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    newPassword: formData.get("newPassword"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const result = await changeOwnPassword(user.id, parsed.data);
  if (!result.ok) return { error: result.message };
  // As outras sessões ficam inválidas; esta recebe um token com a nova versão.
  await createSession({ userId: user.id, email: user.email, name: user.name, role: user.role, sessionVersion: result.value.sessionVersion });
  redirectWith("/account/password", { success: "Palavra-passe alterada. As outras sessões foram terminadas." });
}
