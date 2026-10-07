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
 * A assinatura cobre também a página de destino (`flashScope`): uma mensagem só aparece na página
 * para onde a aplicação redirecionou (ex.: "Credenciais inválidas" só no /login), e cada página
 * indica o seu caminho a `readFlash`.
 *
 * Regra: o texto destas mensagens tem de ser fixo, escrito no servidor (no máximo com números
 * calculados no servidor, ex.: minutos de bloqueio) — nunca nomes, texto livre ou outro input de
 * utilizadores. As mensagens não estão ligadas à sessão: qualquer pessoa consegue obter um URL
 * acabado de assinar com uma mensagem da aplicação e enviá-lo para a página que a produz. Isso é
 * aceitável só porque o texto não é escolhido por quem ataca; mensagens com nomes ou texto do
 * utilizador voltam pelo estado do formulário (useActionState), não pelo URL. O prazo curto
 * (FLASH_TTL_MS) limita a reutilização de um link guardado ou partilhado. O nonce torna cada
 * redirect único (ver `flash-params.ts`).
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

/**
 * Página a que a mensagem se destina, na forma comparada pela assinatura: só o pathname (sem query
 * nem hash), descodificado e sem barra final. Assim `/contacts/abc?q=1`, `/contacts/abc/` e
 * `/contacts/${encodeURIComponent(id)}` dão o mesmo resultado nos dois lados.
 */
export function flashScope(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] || "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  return decoded.length > 1 ? decoded.replace(/\/+$/, "") || "/" : decoded;
}

function signature(key: Buffer, scope: string, messages: FlashMessages, nonce: string, expiry: string): string {
  const canonical = JSON.stringify(["v2", scope, ...FLASH_MESSAGE_PARAMS.map((name) => messages[name] ?? ""), nonce, expiry]);
  return createHmac("sha256", key).update(canonical).digest("base64url").slice(0, 22); // 132 bits
}

/** Valor do parâmetro `f` para estas mensagens, destinadas à página `path`. */
export function signFlash(
  path: string,
  messages: FlashMessages,
  options: { key?: Buffer; now?: Date; nonce?: string } = {},
): string {
  const key = options.key ?? flashKey();
  const nonce = options.nonce ?? randomBytes(4).toString("hex");
  const expiry = Math.floor(((options.now ?? new Date()).getTime() + FLASH_TTL_MS) / 1000).toString(36);
  return `${nonce}.${expiry}.${signature(key, flashScope(path), messages, nonce, expiry)}`;
}

/** Caminho com as mensagens assinadas para essa página (o caminho pode já ter query, ex.: filtros). */
export function flashUrl(path: string, messages: FlashMessages, options: { key?: Buffer; now?: Date; nonce?: string } = {}): string {
  const params = new URLSearchParams();
  for (const name of FLASH_MESSAGE_PARAMS) {
    const value = messages[name];
    if (value) params.set(name, value);
  }
  params.set(FLASH_NONCE_PARAM, signFlash(path, messages, options));
  // Os parâmetros ficam antes de um eventual #hash (o browser não envia o hash ao servidor).
  const hashAt = path.indexOf("#");
  const base = hashAt === -1 ? path : path.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : path.slice(hashAt);
  return `${base}${base.includes("?") ? "&" : "?"}${params.toString()}${hash}`;
}

type SearchParams = Partial<Record<string, string | string[]>>;

/**
 * Mensagens verificadas a partir dos parâmetros da página `path` (o caminho da própria página, ex.:
 * `/contacts/${encodeURIComponent(id)}`): devolve `{}` se faltar a assinatura, se não for válida
 * (texto alterado, acrescentado ou forjado, ou assinada para outra página), se tiver expirado ou
 * se algum parâmetro vier repetido.
 */
export function readFlash(params: SearchParams, path: string, options: { key?: Buffer; now?: Date } = {}): FlashMessages {
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
  const expected = Buffer.from(signature(key, flashScope(path), messages, nonce, expiry));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? messages : {};
}
