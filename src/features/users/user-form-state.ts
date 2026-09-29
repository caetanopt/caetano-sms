/** Estado devolvido pelas actions de utilizadores. A palavra-passe temporária só existe aqui (nunca no URL). */
export type UserSecretFormState = {
  error?: string;
  temporaryPassword?: string;
  email?: string;
  values?: { name: string; email: string; role: string };
};
export const initialUserSecretFormState: UserSecretFormState = {};

export type PasswordChangeFormState = { error?: string };
export const initialPasswordChangeFormState: PasswordChangeFormState = {};

export const ROLE_LABELS = { ADMIN: "Administrador", OPERATOR: "Operador", VIEWER: "Leitura" } as const;
