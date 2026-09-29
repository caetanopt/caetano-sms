import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { attemptLogin } from "@/server/services/login";
import { resetDatabase } from "./helpers";

beforeEach(async () => {
  await resetDatabase();
  await prisma.user.create({
    data: { email: "ana@test.local", name: "Ana", role: "OPERATOR", passwordHash: await bcrypt.hash("correct-password", 4) },
  });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("attemptLogin", () => {
  it("logs in, audits and stores only hashes", async () => {
    expect(await attemptLogin({ email: " ANA@test.local ", password: "correct-password", ip: "203.0.113.7" })).toMatchObject({ ok: true });
    const attempt = await prisma.loginAttempt.findFirstOrThrow();
    expect(JSON.stringify(attempt)).not.toContain("ana@test.local");
    expect(JSON.stringify(attempt)).not.toContain("203.0.113.7");
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGIN_SUCCEEDED" } })).toMatchObject({ ipAddress: "203.0.113.7" });
  });

  it("locks the account after 5 failures, even with the correct password", async () => {
    for (let i = 0; i < 5; i += 1) {
      expect(await attemptLogin({ email: "ana@test.local", password: "wrong", ip: null })).toMatchObject({ reason: "invalid" });
    }
    expect(await attemptLogin({ email: "ana@test.local", password: "correct-password", ip: null })).toMatchObject({
      ok: false,
      reason: "blocked",
    });
    // Após a janela volta a permitir.
    const later = new Date(Date.now() + 16 * 60_000);
    expect(await attemptLogin({ email: "ana@test.local", password: "correct-password", ip: null, now: later })).toMatchObject({ ok: true });
  });

  it("treats unknown users like wrong passwords (no enumeration)", async () => {
    expect(await attemptLogin({ email: "nobody@test.local", password: "x", ip: null })).toEqual({ ok: false, reason: "invalid" });
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGIN_FAILED" } })).toMatchObject({
      metadataJson: { reason: "unknown_user" },
    });
  });

  it("blocks an IP that tries many accounts", async () => {
    for (let i = 0; i < 20; i += 1) await attemptLogin({ email: `u${i}@test.local`, password: "x", ip: "198.51.100.9" });
    expect(await attemptLogin({ email: "ana@test.local", password: "correct-password", ip: "198.51.100.9" })).toMatchObject({
      reason: "blocked",
    });
    expect(await attemptLogin({ email: "ana@test.local", password: "correct-password", ip: "198.51.100.10" })).toMatchObject({ ok: true });
  }, 30_000); // 20 comparações bcrypt de custo 12 (tempo constante para utilizadores inexistentes)
});
