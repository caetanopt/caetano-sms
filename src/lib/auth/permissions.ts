export type Role = "ADMIN" | "OPERATOR" | "VIEWER";

export type Permission =
  | "contacts:write"
  | "contacts:import"
  | "contacts:delete"
  /** Voltar a registar opt-in num número que está em opt-out/suppression list. */
  | "contacts:reopt-in"
  | "lists:write"
  | "lists:delete"
  | "templates:write"
  | "campaigns:write"
  /** Confirmar, processar e cancelar campanhas. */
  | "campaigns:send"
  | "sms:send";

const MATRIX: Record<Permission, readonly Role[]> = {
  "contacts:write": ["ADMIN", "OPERATOR"],
  "contacts:import": ["ADMIN", "OPERATOR"],
  "contacts:delete": ["ADMIN"],
  "contacts:reopt-in": ["ADMIN"],
  "lists:write": ["ADMIN", "OPERATOR"],
  "lists:delete": ["ADMIN"],
  "templates:write": ["ADMIN", "OPERATOR"],
  "campaigns:write": ["ADMIN", "OPERATOR"],
  "campaigns:send": ["ADMIN", "OPERATOR"],
  "sms:send": ["ADMIN", "OPERATOR"],
};

/** Verificação feita sempre no servidor, com a role lida da base de dados. */
export function can(role: Role, permission: Permission) {
  return MATRIX[permission].includes(role);
}
