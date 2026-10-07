import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { FLASH_MESSAGE_PARAMS, FLASH_NONCE_PARAM, type FlashMessages } from "./flash-params";

/**
 * Mensagens de uso único no URL, assinadas (só no servidor).
 *
 * As páginas mostram o texto de `?success=`/`?error=`/`?notice=` tal como vem. Sem assinatura,
 * qualquer pessoa podia enviar um link para o domínio real com um texto à escolha (ex.: "A sua
 * conta foi suspensa, ligue para …") apresentado como alerta oficial — phishing por injeção de
 * texto. Por isso o parâmetro `f` leva `nonce.expiração.assinatura`: HMAC-SHA256 (chave derivada
 * de AUTH_SECRET) sobre as mensagens, o nonce e a expiração. As páginas só mostram mensagens com
 * assinatura válida e dentro do prazo; links forjados ou alterados não mostram nada.
 *
 * O prazo é curto (FLASH_TTL_MS) porque algumas mensagens incluem texto escrito por utilizadores
 * (ex.: nome de uma lista): um URL legítimo deixa de mostrar a mensagem pouco depois do redirect.
 * O nonce torna cada redirect único (ver `flash-params.ts`).
 */
export const FLASH_TTL_MS = 2 * 60_000;
/** Tolerância para relógios ligeiramente diferentes entre instâncias. */
const CLOCK_SKEW_MS = 30_000;
const NONCE = /^[0-9a-f]{8}$/;
const EXPIRY = /^[0-9a-z]{1,11}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{22}$/;

let derivedKey: { source: string; key: Buffer } | null = null;

/** Subchave própria das mensagens (não reutiliza AUTH_SECRET diretamente). */
export function flashKey(secret: string | undefined = process.env.AUTH_SECRET): Buffer {
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters");
  if (derivedKey?.source !== secret) {
    derivedKey = { source: secret, key: createHmac("sha256", secret).update("caetano-sms/flash-messages/v1").digest() };
  }
  return derivedKey.key;
}

function signature(key: Buffer, messages: FlashMessages, nonce: string, expiry: string): string {
  const canonical = JSON.stringify(["v1", ...FLASH_MESSAGE_PARAMS.map((name) => messages[name] ?? ""), nonce, expiry]);
  return createHmac("sha256", key).update(canonical).digest("base64url").slice(0, 22); // 132 bits
}

/** Valor do parâmetro `f` para estas mensagens. */
export function signFlash(
  messages: FlashMessages,
  options: { key?: Buffer; now?: Date; nonce?: string } = {},
): string {
  const key = options.key ?? flashKey();
  const nonce = options.nonce ?? randomBytes(4).toString("hex");
  const expiry = Math.floor(((options.now ?? new Date()).getTime() + FLASH_TTL_MS) / 1000).toString(36);
  return `${nonce}.${expiry}.${signature(key, messages, nonce, expiry)}`;
}

/** Caminho com as mensagens assinadas (o caminho pode já ter query, ex.: filtros). */
export function flashUrl(path: string, messages: FlashMessages, options: { key?: Buffer; now?: Date; nonce?: string } = {}): string {
  const params = new URLSearchParams();
  for (const name of FLASH_MESSAGE_PARAMS) {
    const value = messages[name];
    if (value) params.set(name, value);
  }
  params.set(FLASH_NONCE_PARAM, signFlash(messages, options));
  return `${path}${path.includes("?") ? "&" : "?"}${params.toString()}`;
}

type SearchParams = Partial<Record<string, string | string[]>>;

/**
 * Mensagens verificadas a partir dos parâmetros da página: devolve `{}` se faltar a assinatura,
 * se não for válida (texto alterado, acrescentado ou forjado), se tiver expirado ou se algum
 * parâmetro vier repetido.
 */
export function readFlash(params: SearchParams, options: { key?: Buffer; now?: Date } = {}): FlashMessages {
  const token = params[FLASH_NONCE_PARAM];
  if (typeof token !== "string") return {};
  const messages: FlashMessages = {};
  for (const name of FLASH_MESSAGE_PARAMS) {
    const value = params[name];
    if (Array.isArray(value)) return {};
    if (value) messages[name] = value;
  }
  if (Object.keys(messages).length === 0) return {};

  const [nonce, expiry, given, ...rest] = token.split(".");
  if (rest.length > 0 || !NONCE.test(nonce ?? "") || !EXPIRY.test(expiry ?? "") || !SIGNATURE.test(given ?? "")) return {};
  const expiresAt = parseInt(expiry, 36) * 1000;
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now || expiresAt > now + FLASH_TTL_MS + CLOCK_SKEW_MS) return {};

  let key: Buffer;
  try {
    key = options.key ?? flashKey();
  } catch {
    return {};
  }
  const expected = Buffer.from(signature(key, messages, nonce, expiry));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? messages : {};
}
