import { cookies } from "next/headers";

/**
 * Cookies da aplicação (sessão, 2FA pendente, mensagens). Em produção usam o prefixo `__Host-`: o
 * browser só os aceita com Secure, Path=/ e sem Domain, pelo que outro subdomínio da empresa
 * (ex.: um site comprometido em *.empresa.pt) não consegue plantar um valor seu no browser de um
 * utilizador ("cookie tossing" — ex.: iniciar-lhe sessão na conta de quem ataca, ou fixar o cookie
 * de mensagens). Em desenvolvimento (http) usa-se o nome simples, porque o prefixo exige Secure.
 */
export function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

export function hostCookieName(base: string): string {
  return secureCookies() ? `__Host-${base}` : base;
}

/** Atributos obrigatórios do prefixo (nunca Domain). */
export function hostCookieOptions(options: { sameSite: "lax" | "strict"; maxAge: number }) {
  return { httpOnly: true, secure: secureCookies(), path: "/", ...options };
}

/**
 * Remove o cookie. Com `__Host-` a remoção também tem de ser Secure e Path=/ (senão o browser
 * ignora-a e o cookie continuaria ativo): por isso nunca `cookies().delete(nome)` simples.
 */
export async function deleteHostCookie(base: string, sameSite: "lax" | "strict"): Promise<void> {
  (await cookies()).set(hostCookieName(base), "", hostCookieOptions({ sameSite, maxAge: 0 }));
}

/**
 * Em produção, apaga a versão sem prefixo (anterior ao `__Host-`), que o servidor já não lê:
 * não deixa um token antigo esquecido no browser.
 */
export async function deleteLegacyCookie(base: string): Promise<void> {
  if (!secureCookies()) return;
  (await cookies()).set(base, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}
