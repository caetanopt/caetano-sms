import bcrypt from "bcryptjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base32Decode, totp } from "@/features/auth/totp";
import { decryptSecret, encryptSecret } from "@/lib/auth/mfa-crypto";
import { prisma } from "@/lib/db/prisma";
import type { Actor } from "@/server/services/contacts";
import { attemptLogin } from "@/server/services/login";
import {
  completeMfaLogin,
  confirmMfaEnrollment,
  disableOwnMfa,
  getMfaStatus,
  MFA_PENDING_TTL_MS,
  regenerateRecoveryCodes,
  resetUserMfa,
  startMfaEnrollment,
} from "@/server/services/mfa";
import { updateUser } from "@/server/services/users";
import { createActors, resetDatabase } from "./helpers";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));
process.env.AUTH_SECRET ??= "integration-test-secret-with-at-least-32-chars";
const { createSession, getCurrentUser } = await import("@/lib/auth/session");

const PASSWORD = "uma frase bem longa";
let actors: Record<"admin" | "operator" | "viewer", Actor>;
let clock = new Date("2026-09-29T10:00:00Z").getTime();
const now = () => new Date(clock);
const tick = (seconds = 30) => (clock += seconds * 1000);
const ctx = () => ({ ip: "203.0.113.9", now: now() });

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
  actors = await createActors();
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  await prisma.user.updateMany({ data: { passwordHash } });
  // Os bloqueios contam em relação à hora real da base de dados: usar o relógio real.
  clock = Date.now();
});
afterEach(() => {
  delete process.env.MFA_REQUIRED_FOR_ADMINS;
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Ativa o 2FA e devolve o segredo (bytes) e os códigos de recuperação. */
async function enroll(userId: string) {
  expect(await startMfaEnrollment(userId, ctx())).toEqual({ ok: true, value: undefined });
  const status = await getMfaStatus(userId, now());
  const secret = base32Decode(status!.pending!.secret);
  const confirmed = await confirmMfaEnrollment(userId, totp(secret, now()), ctx());
  if (!confirmed.ok) throw new Error(confirmed.message);
  return { secret, recoveryCodes: confirmed.value.recoveryCodes, sessionVersion: confirmed.value.sessionVersion };
}

async function login(userId: string, mfa: boolean) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await createSession({ userId, email: user.email, name: user.name, role: user.role, sessionVersion: user.sessionVersion, mfa });
}

describe("enrollment", () => {
  it("requires a valid code, stores the secret encrypted and recovery codes hashed, ends other sessions", async () => {
    await login(actors.admin.id, false);
    expect(await getCurrentUser()).toMatchObject({ mfaEnabled: false, mfaSetupRequired: true });

    await startMfaEnrollment(actors.admin.id, ctx());
    const status = await getMfaStatus(actors.admin.id, now());
    expect(status).toMatchObject({ enabled: false, required: true, pending: { uri: expect.stringMatching(/^otpauth:\/\/totp\//) } });
    const secret = base32Decode(status!.pending!.secret);

    expect(await confirmMfaEnrollment(actors.admin.id, "000000", ctx())).toMatchObject({ ok: false });
    const confirmed = await confirmMfaEnrollment(actors.admin.id, totp(secret, now()), ctx());
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.recoveryCodes).toHaveLength(10);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: actors.admin.id } });
    expect(row.totpEnabledAt).not.toBeNull();
    expect(row.totpSecretEnc).not.toContain(status!.pending!.secret);
    expect(decryptSecret(row.totpSecretEnc!)?.equals(secret)).toBe(true);
    const stored = await prisma.mfaRecoveryCode.findMany({ where: { userId: actors.admin.id } });
    expect(stored).toHaveLength(10);
    expect(JSON.stringify(stored)).not.toContain(confirmed.value.recoveryCodes[0].replace("-", ""));

    // A sessão anterior (sem 2FA) deixou de ser válida.
    expect(await getCurrentUser()).toBeNull();
    const audit = (await prisma.auditLog.findMany({ where: { entityId: actors.admin.id } })).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["MFA_ENROLLMENT_STARTED", "MFA_ENROLLMENT_FAILED", "MFA_ENABLED"]));
  });

  it("expires a pending enrollment", async () => {
    await startMfaEnrollment(actors.operator.id, ctx());
    const pending = await getMfaStatus(actors.operator.id, now());
    const secret = base32Decode(pending!.pending!.secret);
    tick(MFA_PENDING_TTL_MS / 1000 + 1);
    expect(await getMfaStatus(actors.operator.id, now())).toMatchObject({ pending: null });
    expect(await confirmMfaEnrollment(actors.operator.id, totp(secret, now()), ctx())).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expirou/),
    });
  });
});

describe("session enforcement", () => {
  it("requires setup only for admins (unless disabled for tests)", async () => {
    await login(actors.operator.id, false);
    expect(await getCurrentUser()).toMatchObject({ mfaSetupRequired: false });
    await login(actors.admin.id, false);
    expect(await getCurrentUser()).toMatchObject({ mfaSetupRequired: true });
    process.env.MFA_REQUIRED_FOR_ADMINS = "false";
    expect(await getCurrentUser()).toMatchObject({ mfaSetupRequired: false });
  });

  it("never accepts a session without second factor once 2FA is enabled", async () => {
    await enroll(actors.admin.id);
    await login(actors.admin.id, false); // versão atual, mas sem mfa
    expect(await getCurrentUser()).toBeNull();
    await login(actors.admin.id, true);
    expect(await getCurrentUser()).toMatchObject({ mfaEnabled: true, mfaSetupRequired: false });
  });

  it("a user promoted to ADMIN must set up 2FA", async () => {
    await updateUser(actors.admin, actors.operator.id, { name: "OPERATOR", role: "ADMIN", isActive: true });
    await login(actors.operator.id, false);
    expect(await getCurrentUser()).toMatchObject({ role: "ADMIN", mfaSetupRequired: true });
  });
});

describe("login with second factor", () => {
  it("defers the session until the code, rejects replays and accepts each recovery code once", async () => {
    const { secret, recoveryCodes } = await enroll(actors.admin.id);
    tick();

    const password = await attemptLogin({ email: "admin@test.local", password: PASSWORD, ip: "203.0.113.9", now: now() });
    expect(password).toMatchObject({ ok: true, user: { mfaRequired: true } });
    if (!password.ok) return;
    expect(await prisma.auditLog.count({ where: { action: "LOGIN_PASSWORD_VERIFIED" } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: actors.admin.id } })).lastLoginAt).toBeNull();

    const pending = { userId: actors.admin.id, sessionVersion: password.user.sessionVersion };
    const code = totp(secret, now());
    expect(await completeMfaLogin(pending, code, ctx())).toMatchObject({ ok: true, value: { method: "totp" } });
    // O mesmo código não pode ser reutilizado (nem noutro pedido).
    expect(await completeMfaLogin(pending, code, ctx())).toMatchObject({ ok: false });

    const recovery = recoveryCodes[0].toLowerCase();
    expect(await completeMfaLogin(pending, recovery, ctx())).toMatchObject({ ok: true, value: { method: "recovery", recoveryCodesRemaining: 9 } });
    expect(await completeMfaLogin(pending, recovery, ctx())).toMatchObject({ ok: false });

    const actions = (await prisma.auditLog.findMany({ where: { userId: actors.admin.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["LOGIN_SUCCEEDED", "MFA_RECOVERY_CODE_USED", "LOGIN_MFA_FAILED"]));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: actors.admin.id } })).lastLoginAt).not.toBeNull();
  });

  it("locks after repeated wrong codes (shared with the password lockout)", async () => {
    const { secret } = await enroll(actors.admin.id);
    const pending = { userId: actors.admin.id, sessionVersion: (await prisma.user.findUniqueOrThrow({ where: { id: actors.admin.id } })).sessionVersion };
    for (let i = 0; i < 5; i += 1) expect(await completeMfaLogin(pending, "111111", ctx())).toMatchObject({ ok: false });
    tick();
    expect(await completeMfaLogin(pending, totp(secret, now()), ctx())).toMatchObject({ ok: false, message: expect.stringMatching(/Demasiadas/) });
    expect(await attemptLogin({ email: "admin@test.local", password: PASSWORD, ip: null })).toMatchObject({ ok: false, reason: "blocked" });
  }, 20_000);

  it("restarts the login when the account changed after the password step", async () => {
    const { secret } = await enroll(actors.operator.id);
    const before = (await prisma.user.findUniqueOrThrow({ where: { id: actors.operator.id } })).sessionVersion;
    await updateUser(actors.admin, actors.operator.id, { name: "OPERATOR", role: "OPERATOR", isActive: false });
    tick();
    expect(await completeMfaLogin({ userId: actors.operator.id, sessionVersion: before }, totp(secret, now()), ctx())).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expirou/),
    });
  });
});

describe("management", () => {
  it("regenerates recovery codes with a current TOTP code only", async () => {
    const { secret, recoveryCodes } = await enroll(actors.admin.id);
    tick();
    expect(await regenerateRecoveryCodes(actors.admin.id, recoveryCodes[0], ctx())).toMatchObject({ ok: false });
    const regenerated = await regenerateRecoveryCodes(actors.admin.id, totp(secret, now()), ctx());
    expect(regenerated.ok).toBe(true);
    const pending = { userId: actors.admin.id, sessionVersion: (await prisma.user.findUniqueOrThrow({ where: { id: actors.admin.id } })).sessionVersion };
    expect(await completeMfaLogin(pending, recoveryCodes[1], ctx())).toMatchObject({ ok: false });
    if (regenerated.ok) expect(await completeMfaLogin(pending, regenerated.value.recoveryCodes[0], ctx())).toMatchObject({ ok: true });
  });

  it("admins cannot disable their own 2FA; other roles can with password and code", async () => {
    const admin = await enroll(actors.admin.id);
    tick();
    expect(await disableOwnMfa(actors.admin.id, { password: PASSWORD, code: totp(admin.secret, now()) }, ctx())).toMatchObject({
      ok: false,
      message: expect.stringMatching(/obrigatório/),
    });

    const operator = await enroll(actors.operator.id);
    tick();
    expect(await disableOwnMfa(actors.operator.id, { password: "errada", code: totp(operator.secret, now()) }, ctx())).toMatchObject({ ok: false });
    const disabled = await disableOwnMfa(actors.operator.id, { password: PASSWORD, code: totp(operator.secret, now()) }, ctx());
    expect(disabled).toMatchObject({ ok: true, value: { sessionVersion: operator.sessionVersion + 1 } });
    expect(await prisma.mfaRecoveryCode.count({ where: { userId: actors.operator.id } })).toBe(0);
    expect(await attemptLogin({ email: "operator@test.local", password: PASSWORD, ip: null })).toMatchObject({ ok: true, user: { mfaRequired: false } });
  });

  it("another admin can reset 2FA (ends sessions, re-setup required); never on yourself", async () => {
    const second = await prisma.user.create({
      data: { name: "Admin 2", email: "admin2@test.local", role: "ADMIN", passwordHash: await bcrypt.hash(PASSWORD, 4) },
    });
    await enroll(second.id);
    await login(second.id, true);
    expect(await getCurrentUser()).toMatchObject({ id: second.id });

    expect(await resetUserMfa(actors.operator, second.id, ctx())).toMatchObject({ ok: false });
    expect(await resetUserMfa({ id: second.id, role: "ADMIN" }, second.id, ctx())).toMatchObject({ ok: false });
    expect(await resetUserMfa(actors.admin, second.id, ctx())).toEqual({ ok: true, value: undefined });
    expect(await getCurrentUser()).toBeNull();
    expect(await resetUserMfa(actors.admin, second.id, ctx())).toMatchObject({ ok: false });

    expect(await attemptLogin({ email: "admin2@test.local", password: PASSWORD, ip: null })).toMatchObject({ ok: true, user: { mfaRequired: false } });
    await login(second.id, false);
    expect(await getCurrentUser()).toMatchObject({ mfaSetupRequired: true });
    expect(await prisma.auditLog.count({ where: { action: "USER_MFA_RESET", userId: actors.admin.id } })).toBe(1);
  });
});

describe("secret encryption", () => {
  it("fails closed with a different key", () => {
    const encrypted = encryptSecret(Buffer.from("12345678901234567890"));
    const original = process.env.AUTH_SECRET;
    process.env.MFA_ENCRYPTION_KEY = "another-key-with-at-least-32-characters!!";
    expect(decryptSecret(encrypted)).toBeNull();
    delete process.env.MFA_ENCRYPTION_KEY;
    expect(decryptSecret(encrypted)?.toString()).toBe("12345678901234567890");
    expect(decryptSecret("v1:garbage")).toBeNull();
    process.env.AUTH_SECRET = original;
  });
});
