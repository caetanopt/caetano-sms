import { redirect } from "next/navigation";
import { flashUrl } from "./flash";
import type { FlashMessages } from "./flash-params";

/**
 * Redireciona com uma mensagem de feedback de uso único em query string, assinada e com prazo
 * (`flash.ts`): a página só a mostra se a assinatura for válida (`readFlash`), e
 * `ConsumeFlashParams` retira-a do URL depois de mostrada.
 *
 * O texto tem de ser fixo, escrito no servidor (sem nomes nem input de utilizadores): ver a regra
 * em `flash.ts`. Mensagens com conteúdo do utilizador devolvem-se pelo estado do formulário.
 *
 * Assíncrona (lê/cria o cookie que liga a mensagem ao browser): usar SEMPRE `return redirectWith(…)`
 * — sem o `return`, a ação continuaria a correr (um teste garante isto).
 */
export async function redirectWith(path: string, feedback: Pick<FlashMessages, "success" | "error">): Promise<never> {
  redirect(await flashUrl(path, feedback));
}
