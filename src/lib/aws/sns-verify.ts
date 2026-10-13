import { createVerify, X509Certificate } from "node:crypto";
import { z } from "zod";

/**
 * Validação de mensagens HTTP do Amazon SNS (CLAUDE.md §22): assinatura, certificado
 * de origem, tópico autorizado e janela temporal (proteção contra replay).
 */

export const snsEnvelopeSchema = z.object({
  Type: z.enum(["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"]),
  MessageId: z.string().min(1).max(200),
  TopicArn: z.string().min(1).max(500),
  Message: z.string().max(256 * 1024),
  Timestamp: z.string().min(1),
  SignatureVersion: z.enum(["1", "2"]),
  Signature: z.string().min(1),
  SigningCertURL: z.string().url(),
  Subject: z.string().optional(),
  SubscribeURL: z.string().url().optional(),
  Token: z.string().optional(),
  UnsubscribeURL: z.string().url().optional(),
});

export type SnsEnvelope = z.infer<typeof snsEnvelopeSchema>;

/** Só certificados/URLs servidos por SNS da AWS (https, sns.<região>.amazonaws.com). */
export function isAwsSnsUrl(value: string, kind: "cert" | "subscribe") {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (!/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname)) return false;
  return kind === "cert" ? url.pathname.endsWith(".pem") : true;
}

/** Texto canónico assinado pelo SNS (ordem e campos definidos pela AWS). */
export function stringToSign(envelope: SnsEnvelope) {
  const keys =
    envelope.Type === "Notification"
      ? (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const)
      : (["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const);
  return keys
    .filter((key) => envelope[key] !== undefined)
    .map((key) => `${key}\n${envelope[key]}\n`)
    .join("");
}

export type SnsVerifyDeps = {
  /** Devolve o PEM do certificado (com cache). */
  fetchCertificate: (url: string) => Promise<string>;
  allowedTopicArns: readonly string[];
  now: () => Date;
  /** Idade máxima aceite da mensagem. */
  maxAgeMs?: number;
};

export type SnsVerifyResult = { ok: true; envelope: SnsEnvelope } | { ok: false; reason: string };

const DEFAULT_MAX_AGE_MS = 60 * 60_000;

export async function verifySnsMessage(raw: unknown, deps: SnsVerifyDeps): Promise<SnsVerifyResult> {
  const parsed = snsEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid_envelope" };
  const envelope = parsed.data;

  if (!deps.allowedTopicArns.includes(envelope.TopicArn)) return { ok: false, reason: "topic_not_allowed" };
  if (!isAwsSnsUrl(envelope.SigningCertURL, "cert")) return { ok: false, reason: "invalid_cert_url" };

  const timestamp = Date.parse(envelope.Timestamp);
  const age = deps.now().getTime() - timestamp;
  if (!Number.isFinite(timestamp) || age > (deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS) || age < -5 * 60_000) {
    return { ok: false, reason: "stale_or_future_timestamp" };
  }

  let pem: string;
  try {
    pem = await deps.fetchCertificate(envelope.SigningCertURL);
  } catch {
    return { ok: false, reason: "certificate_unavailable" };
  }

  try {
    const certificate = new X509Certificate(pem);
    const verifier = createVerify(envelope.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256");
    verifier.update(stringToSign(envelope), "utf8");
    if (!verifier.verify(certificate.publicKey, envelope.Signature, "base64")) {
      return { ok: false, reason: "invalid_signature" };
    }
  } catch {
    return { ok: false, reason: "invalid_signature" };
  }
  return { ok: true, envelope };
}

const certificateCache = new Map<string, Promise<string>>();

/** Descarrega o certificado do SNS (só URLs validadas), com cache em memória. */
export function fetchSnsCertificate(url: string): Promise<string> {
  if (!isAwsSnsUrl(url, "cert")) return Promise.reject(new Error("invalid cert url"));
  let cached = certificateCache.get(url);
  if (!cached) {
    cached = fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (!text.includes("BEGIN CERTIFICATE") || text.length > 20_000) throw new Error("invalid certificate");
      return text;
    });
    cached.catch(() => certificateCache.delete(url));
    certificateCache.set(url, cached);
  }
  return cached;
}
