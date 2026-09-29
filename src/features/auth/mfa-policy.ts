import type { Role } from "@/lib/auth/permissions";

/**
 * 2FA obrigatório para administradores (CLAUDE.md §27/§28). `MFA_REQUIRED_FOR_ADMINS=false`
 * desativa a obrigatoriedade — apenas para desenvolvimento/testes automáticos; nunca em produção.
 */
export function mfaRequiredFor(role: Role, env: Record<string, string | undefined> = process.env): boolean {
  return role === "ADMIN" && env.MFA_REQUIRED_FOR_ADMINS !== "false";
}

export function mfaIssuer(env: Record<string, string | undefined> = process.env): string {
  const issuer = (env.MFA_ISSUER ?? "").trim();
  return issuer !== "" && issuer.length <= 40 && !issuer.includes(":") ? issuer : "SMS AWS";
}
