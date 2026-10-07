import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
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
 * A assinatura cobre ainda a sessão do browser: um cookie aleatório e HttpOnly (FLASH_COOKIE),
 * criado na primeira ação que produz uma mensagem. Um link assinado só funciona no browser que o
 * originou; quem obtém um URL assinado (ex.: provocando "Credenciais inválidas") recebe-o ligado ao
 * SEU cookie, que a vítima não tem e não pode ler.
 *
 * Regra: o texto destas mensagens tem de ser fixo, escrito no servidor (no máximo com números
 * calculados no servidor, ex.: minutos de bloqueio) — nunca nomes, texto livre ou outro input de
 * utilizadores; esses voltam pelo estado do formulário (useActionState), não pelo URL. O prazo
 * curto (FLASH_TTL_MS) limita a reutilização de um link guardado. O nonce torna cada redirect
 * único (ver `flash-params.ts`).
 */
export const FLASH_TTL_MS = 2 * 60_000;
/** Tolerância para relógios ligeiramente diferentes entre instâncias. */
const CLOCK_SKEW_MS = 30_000;
const NONCE = /^[0-9a-f]{8}$/;
const EXPIRY = /^[0-9a-z]{1,11}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{22}$/;
const BINDING = /^[A-Za-z0-9_-]{22}$/;
/** Cookie que liga as mensagens ao browser (não é a sessão de login: existe também no /login). */
export const FLASH_COOKIE = "sms_flash_bid";

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

function signature(key: Buffer, binding: string, scope: string, messages: FlashMessages, nonce: string, expiry: string): string {
  const canonical = JSON.stringify(["v3", binding, scope, ...FLASH_MESSAGE_PARAMS.map((name) => messages[name] ?? ""), nonce, expiry]);
  return createHmac("sha256", key).update(canonical).digest("base64url").slice(0, 22); // 132 bits
}

type SignOptions = { binding: string; key?: Buffer; now?: Date; nonce?: string };

/** Valor do parâmetro `f` para estas mensagens, destinadas à página `path` e ao browser `binding`. */
export function signFlash(path: string, messages: FlashMessages, options: SignOptions): string {
  const key = options.key ?? flashKey();
  const nonce = options.nonce ?? randomBytes(4).toString("hex");
  const expiry = Math.floor(((options.now ?? new Date()).getTime() + FLASH_TTL_MS) / 1000).toString(36);
  return `${nonce}.${expiry}.${signature(key, options.binding, flashScope(path), messages, nonce, expiry)}`;
}

/** Caminho com as mensagens assinadas (o caminho pode já ter query, ex.: filtros). Função pura. */
export function buildFlashUrl(path: string, messages: FlashMessages, options: SignOptions): string {
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

/**
 * Identificador do browser para ligar as mensagens. Em server actions cria o cookie se faltar;
 * durante a renderização (`canSetCookie: false`) não é possível escrever cookies e devolve null.
 */
async function flashBinding(canSetCookie: boolean): Promise<string | null> {
  const jar = await cookies();
  const current = jar.get(FLASH_COOKIE)?.value;
  if (current && BINDING.test(current)) return current;
  if (!canSetCookie) return null;
  const created = randomBytes(16).toString("base64url");
  jar.set(FLASH_COOKIE, created, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return created;
}

/**
 * Garante o cookie de mensagens (chamar em contextos que podem escrever cookies, ex.: ao iniciar
 * sessão), para que mensagens produzidas durante a renderização — como "Sessão terminada" — tenham
 * a que se ligar.
 */
export async function ensureFlashCookie(): Promise<void> {
  await flashBinding(true);
}

/**
 * Caminho com as mensagens assinadas para esta página e este browser. Sem cookie e sem poder
 * criá-lo (renderização), devolve o caminho sem mensagem: redireciona na mesma, sem texto.
 */
export async function flashUrl(path: string, messages: FlashMessages, options: { canSetCookie?: boolean } = {}): Promise<string> {
  const binding = await flashBinding(options.canSetCookie ?? true);
  return binding ? buildFlashUrl(path, messages, { binding }) : path;
}

type SearchParams = Partial<Record<string, string | string[]>>;

/**
 * Mensagens verificadas a partir dos parâmetros da página `path` (o caminho da própria página, ex.:
 * `/contacts/${encodeURIComponent(id)}`), para o browser deste pedido: devolve `{}` sem cookie,
 * sem assinatura, com assinatura inválida (texto alterado, acrescentado ou forjado, assinada para
 * outra página ou outro browser), expirada, ou com algum parâmetro repetido.
 */
export async function readFlash(params: SearchParams, path: string): Promise<FlashMessages> {
  const binding = await flashBinding(false);
  return binding ? verifyFlash(params, path, { binding }) : {};
}

/** Verificação pura (sem cookies): ver `readFlash`. */
export function verifyFlash(params: SearchParams, path: string, options: { binding: string; key?: Buffer; now?: Date }): FlashMessages {
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
  const expected = Buffer.from(signature(key, options.binding, flashScope(path), messages, nonce, expiry));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? messages : {};
}
