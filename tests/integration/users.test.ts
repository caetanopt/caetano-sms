import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { Actor } from "@/server/services/contacts";
import { attemptLogin } from "@/server/services/login";
import { changeOwnPassword, createUser, resetUserPassword, updateUser } from "@/server/services/users";
import { createActors, resetDatabase } from "./helpers";

// Cookie jar em memória para exercitar createSession/getCurrentUser fora do Next.
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

let actors: Record<"admin" | "operator" | "viewer", Actor>;

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
  actors = await createActors();
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function loginAs(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  await createSession({ userId, email: user.email, name: user.name, role: user.role, sessionVersion: user.sessionVersion });
}

describe("createUser", () => {
  it("creates a user with a temporary password that must be changed, and audits", async () => {
    const result = await createUser(actors.admin, { name: "Rui", email: " RUI@Test.Local ", role: "OPERATOR" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.value.id } });
    expect(user).toMatchObject({ email: "rui@test.local", mustChangePassword: true, role: "OPERATOR" });
    expect(await bcrypt.compare(result.value.temporaryPassword, user.passwordHash)).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "USER_CREATED" } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain(result.value.temporaryPassword);

    const login = await attemptLogin({ email: "rui@test.local", password: result.value.temporaryPassword, ip: null });
    expect(login).toMatchObject({ ok: true, user: { mustChangePassword: true } });
  });

  it("rejects duplicate emails and non-admin actors", async () => {
    expect(await createUser(actors.admin, { name: "X", email: "operator@test.local", role: "VIEWER" })).toMatchObject({ ok: false });
    expect(await createUser(actors.operator, { name: "X", email: "new@test.local", role: "ADMIN" })).toMatchObject({ ok: false });
    expect(await prisma.user.count({ where: { email: "new@test.local" } })).toBe(0);
  });
});

describe("updateUser", () => {
  it("never leaves zero active admins and blocks self-demotion/deactivation", async () => {
    expect(await updateUser(actors.admin, actors.admin.id, { name: "A", role: "OPERATOR", isActive: true })).toMatchObject({ ok: false });
    expect(await updateUser(actors.admin, actors.admin.id, { name: "A", role: "ADMIN", isActive: false })).toMatchObject({ ok: false });
    // Renomear-se é permitido.
    expect(await updateUser(actors.admin, actors.admin.id, { name: "Admin Novo", role: "ADMIN", isActive: true })).toMatchObject({ ok: true });

    const second = await prisma.user.create({ data: { name: "B", email: "b@test.local", passwordHash: "x", role: "ADMIN" } });
    expect(await updateUser(actors.admin, second.id, { name: "B", role: "VIEWER", isActive: true })).toMatchObject({ ok: true });
    expect(await prisma.user.count({ where: { role: "ADMIN", isActive: true } })).toBe(1);
  });

  it("rejects demoting or deactivating the last active admin", async () => {
    const other = await prisma.user.create({ data: { name: "B", email: "b@test.local", passwordHash: "x", role: "ADMIN", isActive: false } });
    // Reativar `other`, que depois desativa actors.admin; `other` fica o único admin ativo.
    expect(await updateUser(actors.admin, other.id, { name: "B", role: "ADMIN", isActive: true })).toMatchObject({ ok: true });
    expect(await updateUser({ id: other.id, role: "ADMIN" }, actors.admin.id, { name: "ADMIN", role: "ADMIN", isActive: false })).toMatchObject({ ok: true });
    expect(await updateUser(actors.admin, other.id, { name: "B", role: "VIEWER", isActive: true })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/pelo menos um administrador/),
    });
    expect(await updateUser(actors.admin, other.id, { name: "B", role: "ADMIN", isActive: false })).toMatchObject({ ok: false });
  });

  it("invalidates open sessions when role or active state changes, not on rename", async () => {
    await loginAs(actors.operator.id);
    expect(await getCurrentUser()).toMatchObject({ id: actors.operator.id, role: "OPERATOR" });

    await updateUser(actors.admin, actors.operator.id, { name: "Operador Renomeado", role: "OPERATOR", isActive: true });
    expect(await getCurrentUser()).toMatchObject({ name: "Operador Renomeado" });

    await updateUser(actors.admin, actors.operator.id, { name: "Operador Renomeado", role: "VIEWER", isActive: true });
    expect(await getCurrentUser()).toBeNull();

    await loginAs(actors.operator.id);
    expect(await getCurrentUser()).toMatchObject({ role: "VIEWER" });
    await updateUser(actors.admin, actors.operator.id, { name: "Operador Renomeado", role: "VIEWER", isActive: false });
    expect(await getCurrentUser()).toBeNull();
    expect(await attemptLogin({ email: "operator@test.local", password: "x", ip: null })).toMatchObject({ ok: false });

    const actions = (await prisma.auditLog.findMany({ where: { entityId: actors.operator.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["USER_UPDATED", "USER_ROLE_CHANGED", "USER_DEACTIVATED"]));
  });

  it("is admin-only", async () => {
    expect(await updateUser(actors.operator, actors.viewer.id, { name: "V", role: "ADMIN", isActive: true })).toMatchObject({ ok: false });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: actors.viewer.id } })).role).toBe("VIEWER");
  });
});

describe("password reset and change", () => {
  it("reset ends sessions and forces a change; change clears the flag and keeps only the new session", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { passwordHash: await bcrypt.hash("old-password-long", 4) } });
    await loginAs(actors.operator.id);

    expect(await resetUserPassword(actors.admin, actors.admin.id)).toMatchObject({ ok: false });
    expect(await resetUserPassword(actors.operator, actors.viewer.id)).toMatchObject({ ok: false });
    const reset = await resetUserPassword(actors.admin, actors.operator.id);
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(await getCurrentUser()).toBeNull();

    await loginAs(actors.operator.id);
    expect(await getCurrentUser()).toMatchObject({ mustChangePassword: true });
    const stale = jar.get("sms_session");

    const temp = reset.value.temporaryPassword;
    expect(await changeOwnPassword(actors.operator.id, { currentPassword: "wrong", newPassword: "uma frase bem longa" })).toMatchObject({ ok: false });
    expect(await prisma.auditLog.count({ where: { action: "PASSWORD_CHANGE_FAILED" } })).toBe(1);
    expect(await changeOwnPassword(actors.operator.id, { currentPassword: temp, newPassword: "curta" })).toMatchObject({ ok: false });
    expect(await changeOwnPassword(actors.operator.id, { currentPassword: temp, newPassword: temp })).toMatchObject({ ok: false });

    const changed = await changeOwnPassword(actors.operator.id, { currentPassword: temp, newPassword: "uma frase bem longa" });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(await getCurrentUser()).toBeNull(); // o token antigo deixou de ser válido
    await loginAs(actors.operator.id);
    expect(await getCurrentUser()).toMatchObject({ mustChangePassword: false });
    expect(jar.get("sms_session")).not.toBe(stale);

    expect(await attemptLogin({ email: "operator@test.local", password: temp, ip: null })).toMatchObject({ ok: false });
    expect(await attemptLogin({ email: "operator@test.local", password: "uma frase bem longa", ip: null })).toMatchObject({ ok: true });
  }, 30_000);
});
