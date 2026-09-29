import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getRetentionPolicy } from "@/features/retention/policy";
import { prisma } from "@/lib/db/prisma";
import type { Actor } from "@/server/services/contacts";
import { runRetention } from "@/server/services/retention";
import { createActors, resetDatabase } from "./helpers";

let actors: Record<"admin" | "operator" | "viewer", Actor>;
const DAY = 24 * 60 * 60_000;
const old = new Date(Date.now() - 400 * DAY);

beforeEach(async () => {
  await resetDatabase();
  actors = await createActors();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const message = (overrides: Record<string, unknown>) =>
  prisma.smsMessage.create({
    data: {
      idempotencyKey: crypto.randomUUID(),
      destinationPhoneE164: "+351912345678",
      messageType: "TRANSACTIONAL",
      body: "Olá Maria, código 1234",
      provider: "fake",
      status: "DELIVERED",
      createdById: actors.operator.id,
      ...overrides,
    },
  });

describe("runRetention", () => {
  it("simulates by default and changes nothing", async () => {
    await message({ createdAt: old });
    const report = await runRetention(getRetentionPolicy({}), { apply: false });
    expect(report).toMatchObject({ apply: false, smsToAnonymize: 1 });
    expect((await prisma.smsMessage.findFirstOrThrow()).body).toBe("Olá Maria, código 1234");
  });

  it("anonymizes old messages, keeps recent and in-flight ones, and is idempotent", async () => {
    const oldOne = await message({ createdAt: old });
    const recent = await message({});
    const inFlight = await message({ createdAt: old, status: "SENT" });
    await prisma.loginAttempt.create({ data: { emailHash: "h", success: false, createdAt: old } });
    await prisma.auditLog.create({ data: { action: "LOGIN_FAILED", entityType: "User", ipAddress: "203.0.113.7", createdAt: old } });

    await runRetention(getRetentionPolicy({}), { apply: true });
    expect(await prisma.smsMessage.findUniqueOrThrow({ where: { id: oldOne.id } })).toMatchObject({
      body: "[anonimizado]",
      destinationPhoneE164: "+351******678",
    });
    expect((await prisma.smsMessage.findUniqueOrThrow({ where: { id: recent.id } })).body).toContain("Maria");
    expect((await prisma.smsMessage.findUniqueOrThrow({ where: { id: inFlight.id } })).anonymizedAt).toBeNull();
    expect(await prisma.loginAttempt.count()).toBe(0);
    expect(await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGIN_FAILED" } })).toMatchObject({ ipAddress: null });
    expect(await prisma.auditLog.count({ where: { action: "RETENTION_APPLIED" } })).toBe(1);

    const again = await runRetention(getRetentionPolicy({}), { apply: true });
    expect(again.smsToAnonymize).toBe(0);
  });

  it("rejects unsafe retention settings", () => {
    expect(() => getRetentionPolicy({ SMS_RETENTION_DAYS: "5" })).toThrow();
    expect(getRetentionPolicy({ SMS_RETENTION_DAYS: "180" }).smsDays).toBe(180);
  });
});
