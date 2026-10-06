import { redirect } from "next/navigation";
import { flashUrl, type FlashMessages } from "./flash-params";

/**
 * Redireciona com uma mensagem de feedback de uso único em query string (lida pela página e
 * retirada do URL por `ConsumeFlashParams`). Cada redirect leva um nonce: ver `flash-params.ts`.
 */
export function redirectWith(path: string, feedback: Pick<FlashMessages, "success" | "error">): never {
  redirect(flashUrl(path, feedback));
}
