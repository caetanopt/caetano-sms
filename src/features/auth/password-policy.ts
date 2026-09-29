import { randomBytes } from "node:crypto";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

const COMMON = ["password", "palavrapasse", "123456789012", "qwertyuiopas", "administrador", "changeme"];

/** Regras mínimas (NIST 800-63B: comprimento, sem composição forçada, sem óbvias). */
export function checkPasswordPolicy(password: string, context: { email: string; name?: string }): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `A palavra-passe deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.length > MAX_PASSWORD_LENGTH) return "Palavra-passe demasiado longa.";
  const lower = password.toLowerCase();
  const local = context.email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && lower.includes(local)) return "A palavra-passe não pode conter o email.";
  if (COMMON.some((word) => lower.includes(word))) return "Palavra-passe demasiado comum.";
  if (/^(.)\1+$/.test(password)) return "Palavra-passe demasiado simples.";
  return null;
}

/** Palavra-passe temporária forte (mostrada uma única vez ao administrador). */
export function generateTemporaryPassword() {
  return randomBytes(15).toString("base64url"); // 20 caracteres
}
