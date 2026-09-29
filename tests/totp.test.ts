import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  formatSecretForDisplay,
  generateRecoveryCodes,
  generateTotpSecret,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  totp,
  verifyTotp,
} from "@/features/auth/totp";

// Segredo dos vetores de teste oficiais (RFC 4226 / RFC 6238, SHA1).
const RFC_SECRET = Buffer.from("12345678901234567890");

describe("HOTP/TOTP", () => {
  it("matches the RFC 4226 HOTP test vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it("matches the RFC 6238 TOTP test vectors (8 digits, SHA1)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) expect(totp(RFC_SECRET, new Date(seconds * 1000), 8)).toBe(code);
  });

  it("verifies within ±1 step, returns the step and rejects reuse", () => {
    const at = new Date(1_790_000_000_000);
    const code = totp(RFC_SECRET, at);
    const step = verifyTotp(RFC_SECRET, code, at);
    expect(step).toBe(Math.floor(at.getTime() / 30_000));
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 30_000))).toBe(step);
    expect(verifyTotp(RFC_SECRET, code, new Date(at.getTime() + 90_000))).toBeNull();
    // Reutilização: o mesmo passo (ou anterior) já não é aceite.
    expect(verifyTotp(RFC_SECRET, code, at, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, ` ${code.slice(0, 3)} ${code.slice(3)} `, at)).toBe(step);
    expect(verifyTotp(RFC_SECRET, "12345", at)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "abcdef", at)).toBeNull();
  });
});

describe("base32 and provisioning", () => {
  it("round-trips base32 (RFC 4648 vectors)", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Decode("mzxw 6ytb-oi").toString()).toBe("foobar");
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(20);
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(() => base32Decode("0189")).toThrow();
  });

  it("builds an otpauth URI and a readable secret", () => {
    const uri = otpauthUri({ issuer: "SMS AWS", account: "ana@example.pt", secretBase32: "JBSWY3DPEHPK3PXP" });
    expect(uri).toBe("otpauth://totp/SMS%20AWS%3Aana%40example.pt?secret=JBSWY3DPEHPK3PXP&issuer=SMS+AWS&algorithm=SHA1&digits=6&period=30");
    expect(formatSecretForDisplay("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });
});

describe("recovery codes", () => {
  it("generates unique, well-formed codes and normalizes input", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
      expect(normalizeRecoveryCode(code.toLowerCase())).toBe(code.replace("-", ""));
    }
    expect(normalizeRecoveryCode("123456")).toBeNull();
    expect(normalizeRecoveryCode("ABCDE-FGHI0")).toBeNull();
  });
});
