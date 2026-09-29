import { execSync } from "node:child_process";
import { createSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringToSign, type SnsEnvelope } from "../../src/lib/aws/sns-verify";

/** Par de chaves + certificado auto-assinado gerados no momento (só para testes). */
export function createTestSigner() {
  const dir = mkdtempSync(join(tmpdir(), "sns-test-"));
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/key.pem -out ${dir}/cert.pem -days 1 -subj "/CN=sns.amazonaws.com" 2>/dev/null`,
  );
  const key = readFileSync(join(dir, "key.pem"), "utf8");
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  const certUrl = "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem";

  function sign(fields: Omit<SnsEnvelope, "Signature" | "SignatureVersion" | "SigningCertURL">, version: "1" | "2" = "2") {
    const envelope = { ...fields, SignatureVersion: version, SigningCertURL: certUrl, Signature: "" } as SnsEnvelope;
    const signer = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
    signer.update(stringToSign(envelope), "utf8");
    envelope.Signature = signer.sign(key, "base64");
    return envelope;
  }

  return { cert, certUrl, sign, fetchCertificate: async (url: string) => (url === certUrl ? cert : Promise.reject(new Error("unknown"))) };
}
