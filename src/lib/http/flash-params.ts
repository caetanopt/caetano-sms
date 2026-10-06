/**
 * Parâmetros de URL usados como mensagens de uso único: `success`/`error` (`redirectWith`) e
 * `notice` (aviso após login com código de recuperação).
 */
export const FLASH_PARAMS = ["success", "error", "notice"] as const;

/**
 * Caminho relativo (pathname + query + hash) sem as mensagens de uso único, mantendo os restantes
 * parâmetros (filtros, página). Devolve `null` quando não há nada a remover.
 */
export function urlWithoutFlashParams(href: string): string | null {
  const url = new URL(href);
  const present = FLASH_PARAMS.filter((key) => url.searchParams.has(key));
  if (present.length === 0) return null;
  for (const key of present) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}
