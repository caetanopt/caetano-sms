/**
 * Mensagens de uso único em query string: `success`/`error` (`redirectWith`) e `notice` (aviso após
 * login com código de recuperação), mais um nonce `f` que torna cada redirect único.
 *
 * O nonce é necessário porque `ConsumeFlashParams` retira as mensagens do URL com
 * `history.replaceState`, e o router do Next mantém a página guardada com a query antiga. Sem o
 * nonce, um segundo redirect com a mesma mensagem (ex.: adicionar dois contactos seguidos a uma
 * lista) reutilizaria essa página e descartaria os dados novos do servidor.
 */
export const FLASH_MESSAGE_PARAMS = ["success", "error", "notice"] as const;
export const FLASH_NONCE_PARAM = "f";
export const FLASH_PARAMS = [...FLASH_MESSAGE_PARAMS, FLASH_NONCE_PARAM] as const;

export type FlashMessages = Partial<Record<(typeof FLASH_MESSAGE_PARAMS)[number], string>>;

/** Caminho com as mensagens e um nonce novo (o caminho pode já ter query, ex.: filtros). */
export function flashUrl(path: string, messages: FlashMessages, nonce: string = crypto.randomUUID().slice(0, 8)): string {
  const params = new URLSearchParams();
  for (const key of FLASH_MESSAGE_PARAMS) {
    const value = messages[key];
    if (value) params.set(key, value);
  }
  params.set(FLASH_NONCE_PARAM, nonce);
  return `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
}

/**
 * Caminho relativo (pathname + query + hash) sem as mensagens de uso único nem o nonce, mantendo
 * os restantes parâmetros (filtros, página). Devolve `null` quando não há nada a remover.
 */
export function urlWithoutFlashParams(href: string): string | null {
  const url = new URL(href);
  const present = FLASH_PARAMS.filter((key) => url.searchParams.has(key));
  if (present.length === 0) return null;
  for (const key of present) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}
