import { redirect } from "next/navigation";
import { flashUrl } from "./flash";
import type { FlashMessages } from "./flash-params";

/**
 * Redireciona com uma mensagem de feedback de uso único em query string, assinada e com prazo
 * (`flash.ts`): a página só a mostra se a assinatura for válida (`readFlash`), e
 * `ConsumeFlashParams` retira-a do URL depois de mostrada.
 */
export function redirectWith(path: string, feedback: Pick<FlashMessages, "success" | "error">): never {
  redirect(flashUrl(path, feedback));
}
