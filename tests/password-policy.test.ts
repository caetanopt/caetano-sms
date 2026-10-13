import { describe, expect, it } from "vitest";
import { checkPasswordPolicy, generateTemporaryPassword, MIN_PASSWORD_LENGTH } from "@/features/auth/password-policy";

const ctx = { email: "maria.silva@example.pt", name: "Maria Silva" };

describe("checkPasswordPolicy", () => {
  it("accepts a long passphrase", () => {
    expect(checkPasswordPolicy("cavalo bateria agrafo correto", ctx)).toBeNull();
  });

  it("enforces minimum and maximum length", () => {
    expect(checkPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH - 1) + "b".slice(1), ctx)).toMatch(/pelo menos/);
    expect(checkPasswordPolicy("x".repeat(201), ctx)).toMatch(/longa/);
  });

  it("rejects passwords containing the email local part (case-insensitive)", () => {
    expect(checkPasswordPolicy("MARIA.SILVA-2026!", ctx)).toMatch(/email/);
  });

  it("rejects common words and single repeated characters", () => {
    expect(checkPasswordPolicy("MyPassword2026", ctx)).toMatch(/comum/);
    expect(checkPasswordPolicy("zzzzzzzzzzzzzz", ctx)).toMatch(/simples/);
  });

  it("does not match short email local parts", () => {
    expect(checkPasswordPolicy("joao-bom-dia-a-todos", { email: "jo@x.pt" })).toBeNull();
  });
});

describe("generateTemporaryPassword", () => {
  it("generates unique passwords that satisfy the policy", () => {
    const a = generateTemporaryPassword();
    const b = generateTemporaryPassword();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
