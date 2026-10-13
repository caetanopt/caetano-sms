import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Cifra dos segredos TOTP em repouso (AES-256-GCM). A chave deriva (HKDF-SHA256) de
 * MFA_ENCRYPTION_KEY, ou de AUTH_SECRET se não existir. Mudar a chave torna os segredos
 * ilegíveis: os utilizadores terão de reconfigurar o 2FA (reposição por um administrador).
 */
function keyMaterial(env: Record<string, string | undefined> = process.env) {
  const source = env.MFA_ENCRYPTION_KEY || env.AUTH_SECRET;
  if (!source || source.length < 32) throw new Error("MFA_ENCRYPTION_KEY/AUTH_SECRET must contain at least 32 characters");
  return source;
}

function key(purpose: string) {
  return Buffer.from(hkdfSync("sha256", keyMaterial(), "sms-app-mfa", purpose, 32));
}

export function encryptSecret(secret: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key("totp-secret-v1"), iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

/** null se o valor estiver corrompido ou cifrado com outra chave. */
export function decryptSecret(value: string): Buffer | null {
  const [version, iv, tag, data] = value.split(":");
  if (version !== "v1" || !iv || !tag || !data) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key("totp-secret-v1"), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
  } catch {
    return null;
  }
}

/** Hash dos códigos de recuperação (forma normalizada). Nunca se guardam os códigos. */
export function hashRecoveryCode(userId: string, normalized: string): string {
  return createHmac("sha256", key("recovery-code-v1")).update(`${userId}:${normalized}`).digest("hex");
}
