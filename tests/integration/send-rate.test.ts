import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { prismaManualSendStore } from "@/server/repositories/prisma-manual-send-store";
import { claimNextRecipient, recordProviderThrottle, reserveSendCapacity, type SendRateLimits } from "@/server/services/send-rate";
import { createActors, resetDatabase } from "./helpers";

const PT = "+351912345678";
const ES = "+34612345678";
const t0 = new Date("2026-09-29T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

const limits = (overrides: Partial<SendRateLimits["rate"]> = {}): SendRateLimits => ({
  maxPerMinute: 1000,
  originKey: "origin-a",
  userDailyParts: 1000,
  rate: { originMps: 10, countryMps: { PT: 2 }, defaultCountryMps: 1, burstSeconds: 1, ...overrides },
});
let actors: Awaited<ReturnType<typeof createActors>>;
/** Reserva de MPS/minuto em nome do operador de teste. */
const reserve = (target: { phoneE164: string; segments: number }, l: SendRateLimits, now: Date) =>
  reserveSendCapacity(target, actors.operator.id, l, now);

beforeEach(async () => {
  await resetDatabase();
  actors = await createActors();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("reserveSendCapacity (MPS)", () => {
  it("limits parts per second per destination country", async () => {
    expect(await reserve({ phoneE164: PT, segments: 1 }, limits(), t0)).toEqual({ ok: true });
    expect(await reserve({ phoneE164: PT, segments: 1 }, limits(), t0)).toEqual({ ok: true });
    expect(await reserve({ phoneE164: PT, segments: 1 }, limits(), t0)).toMatchObject({
      ok: false,
      limit: "mps",
      label: "país PT",
      retryAfterMs: 500,
    });
    // Outro país tem balde próprio.
    expect(await reserve({ phoneE164: ES, segments: 1 }, limits(), t0)).toEqual({ ok: true });
    expect(await reserve({ phoneE164: PT, segments: 1 }, limits(), at(500))).toEqual({ ok: true });
  });

  it("limits the origination identity across countries, all-or-nothing", async () => {
    const config = limits({ originMps: 2, countryMps: { PT: 10, ES: 10 } });
    expect(await reserve({ phoneE164: PT, segments: 1 }, config, t0)).toEqual({ ok: true });
    expect(await reserve({ phoneE164: ES, segments: 1 }, config, t0)).toEqual({ ok: true });
    expect(await reserve({ phoneE164: ES, segments: 1 }, config, t0)).toMatchObject({ ok: false, label: "identidade de origem" });
    // O bloqueio pela origem não consumiu o balde do país.
    const es = await prisma.sendRateBucket.findFirstOrThrow({ where: { key: { endsWith: ":country:ES" } } });
    expect(es.tokens).toBe(9);
    // Outra identidade de origem é independente.
    expect(await reserve({ phoneE164: ES, segments: 1 }, { ...config, originKey: "origin-b" }, t0)).toEqual({ ok: true });
  });

  it("charges by message parts", async () => {
    const config = limits({ countryMps: { PT: 3 } });
    expect(await reserve({ phoneE164: PT, segments: 3 }, config, t0)).toEqual({ ok: true });
    expect(await reserve({ phoneE164: PT, segments: 1 }, config, t0)).toMatchObject({ ok: false, retryAfterMs: 334 });
  });

  it("still applies the per-minute limit", async () => {
    const result = await reserve({ phoneE164: PT, segments: 1 }, { ...limits(), maxPerMinute: 0 }, t0);
    expect(result).toMatchObject({ ok: false, limit: "per_minute" });
  });

  it("slows down after AWS throttling and never stores the identity or phone", async () => {
    await recordProviderThrottle({ phoneE164: PT }, limits(), t0);
    const rows = await prisma.sendRateBucket.findMany();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.tokens === 0 && row.rateFactor === 0.5 && row.throttledAt !== null)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("origin-a");
    expect(JSON.stringify(rows)).not.toContain("912345678");
    // Ritmo PT a metade: 1 parte demora 1 s em vez de 0,5 s.
    expect(await reserve({ phoneE164: PT, segments: 1 }, limits(), at(500))).toMatchObject({ ok: false, limit: "mps" });
    expect(await reserve({ phoneE164: PT, segments: 1 }, limits(), at(1_000))).toEqual({ ok: true });
  });

  it("serializes concurrent reservations (no overbooking)", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reserve({ phoneE164: PT, segments: 1 }, limits(), t0)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Quota diária por utilizador — via o caminho real do envio individual (reserva + INSERT na
// mesma transação) e via claimNextRecipient para o ritmo por campanha.
// ---------------------------------------------------------------------------

describe("daily quota (prismaManualSendStore.createPendingMessage)", () => {
  let seq = 0;
  const pending = (createdById: string) => {
    seq += 1;
    return {
      idempotencyKey: `quota-${seq}`,
      contactId: null,
      destinationPhoneE164: PT,
      messageType: "TRANSACTIONAL" as const,
      body: "Olá",
      encodingEstimate: "GSM_7" as const,
      segmentCountEstimate: 1,
      provider: "fake",
      dryRun: true,
      templateId: null,
      campaignId: null,
      createdById,
    };
  };
  const reservation = (payerId: string, segments: number, now: Date, l: SendRateLimits = limits({ originMps: 1000, countryMps: { PT: 1000 } })) => ({
    target: { phoneE164: PT, segments },
    payerId,
    limits: l,
    now,
  });
  async function message(createdById: string, data: { segments?: number | null; status?: string; errorCode?: string; createdAt: Date; dryRun?: boolean }) {
    seq += 1;
    await prisma.smsMessage.create({
      data: {
        idempotencyKey: `seed-${seq}`,
        destinationPhoneE164: PT,
        messageType: "TRANSACTIONAL",
        body: "x",
        provider: "fake",
        status: (data.status ?? "ACCEPTED") as "ACCEPTED",
        errorCode: data.errorCode,
        segmentCountEstimate: data.segments === undefined ? 1 : data.segments,
        dryRun: data.dryRun ?? false,
        createdAt: data.createdAt,
        createdById,
      },
    });
  }
  const now = () => new Date();

  it("blocks when the day's parts would exceed the override and never touches MPS buckets", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 3 } });
    await message(actors.operator.id, { segments: 2, createdAt: now() });
    const first = await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, now()));
    expect(first).toMatchObject({ kind: "created" });
    const second = await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, now()));
    expect(second).toMatchObject({
      kind: "rate_limited",
      check: { limit: "user_quota", cost: 1, quota: { used: 3, limit: 3, remaining: 0 } },
    });
    if (second.kind === "rate_limited" && second.check.limit === "user_quota") {
      expect(second.check.quota.resetsAt.getTime()).toBeGreaterThan(Date.now());
    }
    expect(await prisma.smsMessage.count({ where: { createdById: actors.operator.id } })).toBe(2);
    // O bloqueio pela quota acontece antes dos baldes: só a 1.ª reserva os criou/consumiu.
    const buckets = await prisma.sendRateBucket.findMany();
    expect(buckets.every((b) => b.tokens === 999)).toBe(true);
  });

  it("counts only what was (possibly) sent, by the paying user, including dry-run", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 4 } });
    await message(actors.viewer.id, { segments: 100, createdAt: now() }); // outro utilizador
    await message(actors.operator.id, { segments: 1, createdAt: now(), dryRun: true });
    await message(actors.operator.id, { segments: null, createdAt: now() }); // conta 1
    await message(actors.operator.id, { segments: 5, status: "FAILED", errorCode: "THROTTLED", createdAt: now() }); // não conta
    await message(actors.operator.id, { segments: 1, status: "FAILED", errorCode: "INVALID_PHONE_NUMBER", createdAt: now() }); // conta
    // 3 usadas: 1 parte cabe, 2 não.
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 2, now()))).toMatchObject({
      kind: "rate_limited",
      check: { limit: "user_quota", quota: { used: 3 } },
    });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, now()))).toMatchObject({ kind: "created" });
  });

  it("serializes concurrent sends: exactly the quota passes", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 3 } });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, now()))),
    );
    expect(results.filter((r) => r.kind === "created")).toHaveLength(3);
    expect(results.filter((r) => r.kind === "rate_limited")).toHaveLength(7);
    expect(await prisma.smsMessage.count({ where: { createdById: actors.operator.id } })).toBe(3);
  });

  it("blocks a zero quota, an inactive account and a missing payer", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 0 } });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, now()))).toMatchObject({
      kind: "rate_limited",
      check: { limit: "user_quota", quota: { limit: 0 } },
    });
    await prisma.user.update({ where: { id: actors.viewer.id }, data: { isActive: false } });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.viewer.id), reservation(actors.viewer.id, 1, now()))).toMatchObject({
      kind: "rate_limited",
      check: { limit: "user_blocked", reason: "inactive" },
    });
    // Outro utilizador (ativo, sem override) continua a poder enviar.
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, actors.admin.id, limits(), now())).toMatchObject({ ok: true });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, "nope", limits(), now())).toMatchObject({ ok: false, limit: "user_blocked", reason: "missing" });
  });

  it("counts in-flight campaign reservations of the payer (recent ones only)", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 3 } });
    const campaign = await prisma.campaign.create({
      data: { name: "C", messageType: "TRANSACTIONAL", messageBody: "x", status: "SENDING", createdById: actors.admin.id, confirmedById: actors.operator.id },
    });
    const at = now();
    await prisma.campaignRecipient.create({ data: { campaignId: campaign.id, status: "PROCESSING", segments: 2, claimToken: "a", claimedAt: at } });
    await prisma.campaignRecipient.create({
      data: { campaignId: campaign.id, status: "PROCESSING", segments: 2, claimToken: "b", claimedAt: new Date(at.getTime() - 6 * 60_000) },
    });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 2, at))).toMatchObject({
      kind: "rate_limited",
      check: { limit: "user_quota", quota: { used: 2 } },
    });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, at))).toMatchObject({ kind: "created" });
  });

  it("an in-flight reservation whose message already exists counts once (SQS: step reserves while the worker sends)", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 2 } });
    const campaign = await prisma.campaign.create({
      data: { name: "C", messageType: "TRANSACTIONAL", messageBody: "x", status: "SENDING", createdById: actors.admin.id, confirmedById: actors.operator.id },
    });
    const at = now();
    const recipient = await prisma.campaignRecipient.create({
      data: { campaignId: campaign.id, status: "PROCESSING", segments: 1, attempt: 1, claimToken: "a", claimedAt: at },
    });
    // O worker já criou o SmsMessage da tentativa 1, mas o destinatário continua PROCESSING.
    await prisma.smsMessage.create({
      data: {
        idempotencyKey: `campaign:${campaign.id}:${recipient.id}:1`,
        destinationPhoneE164: PT,
        messageType: "TRANSACTIONAL",
        body: "x",
        provider: "fake",
        status: "PENDING",
        segmentCountEstimate: 1,
        campaignId: campaign.id,
        createdById: actors.operator.id,
        createdAt: at,
      },
    });
    // Usado = 1 (não 2): ainda cabe 1 parte.
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, at))).toMatchObject({ kind: "created" });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, at))).toMatchObject({
      kind: "rate_limited",
      check: { limit: "user_quota", quota: { used: 2 } },
    });
  });

  it("resets at 00:00 Lisbon, in summer and winter", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 1 } });
    const summerBefore = new Date("2026-07-01T22:59:50Z");
    await message(actors.operator.id, { createdAt: new Date("2026-07-01T10:00:00Z") });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, summerBefore))).toMatchObject({ kind: "rate_limited" });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, new Date("2026-07-01T23:00:10Z")))).toMatchObject({ kind: "created" });
    await prisma.smsMessage.deleteMany({});
    await message(actors.operator.id, { createdAt: new Date("2026-01-15T10:00:00Z") });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, new Date("2026-01-15T23:59:50Z")))).toMatchObject({ kind: "rate_limited" });
    expect(await prismaManualSendStore.createPendingMessage(pending(actors.operator.id), reservation(actors.operator.id, 1, new Date("2026-01-16T00:00:10Z")))).toMatchObject({ kind: "created" });
  });

  it("a duplicate idempotency key is reported without charging twice", async () => {
    const data = pending(actors.operator.id);
    expect(await prismaManualSendStore.createPendingMessage(data, reservation(actors.operator.id, 1, now()))).toMatchObject({ kind: "created" });
    const before = await prisma.sendRateBucket.findMany({ orderBy: { key: "asc" } });
    expect(await prismaManualSendStore.createPendingMessage(data, reservation(actors.operator.id, 1, now()))).toEqual({ kind: "duplicate" });
    const after = await prisma.sendRateBucket.findMany({ orderBy: { key: "asc" } });
    expect(after.map((b) => b.tokens)).toEqual(before.map((b) => b.tokens));
  });
});

describe("per-campaign pace (claimNextRecipient)", () => {
  async function campaignWithRecipients(maxSendsPerMinute: number | null, recipients: number) {
    const contact = await prisma.contact.create({ data: { name: "Ana", phoneE164: `+3519${String(seqPhone++).padStart(8, "0")}`, consentStatus: "OPTED_IN" } });
    const campaign = await prisma.campaign.create({
      data: { name: "P", messageType: "TRANSACTIONAL", messageBody: "x", status: "SENDING", createdById: actors.admin.id, confirmedById: actors.operator.id, maxSendsPerMinute },
    });
    for (let i = 0; i < recipients; i += 1) {
      const c = i === 0 ? contact : await prisma.contact.create({ data: { name: `A${i}`, phoneE164: `+3519${String(seqPhone++).padStart(8, "0")}`, consentStatus: "OPTED_IN" } });
      await prisma.campaignRecipient.create({ data: { campaignId: campaign.id, contactId: c.id, status: "PENDING", renderedBody: "x", segments: 1 } });
    }
    return campaign.id;
  }
  let seqPhone = 10_000_000;
  const claim = (campaignId: string, maxPerMinute: number, at: Date) =>
    claimNextRecipient({ campaignId, claimToken: crypto.randomUUID(), limits: { ...limits({ originMps: 1000, countryMps: { PT: 1000 } }), maxPerMinute }, now: at });

  it("caps a campaign at its own pace without affecting others; the global limit still wins", async () => {
    const slow = await campaignWithRecipients(1, 3);
    const other = await campaignWithRecipients(null, 2);
    const at = new Date();
    expect((await claim(slow, 1000, at)).kind).toBe("claimed");
    expect(await claim(slow, 1000, at)).toMatchObject({ kind: "rate_limited", limit: "campaign_per_minute", perMinute: 1 });
    expect((await claim(other, 1000, at)).kind).toBe("claimed");
    // Passado o minuto volta a poder reservar.
    expect((await claim(slow, 1000, new Date(at.getTime() + 61_000))).kind).toBe("claimed");

    const fast = await campaignWithRecipients(5, 2);
    // Global 1 mensagem/min e já há 1 reserva recente (a de `slow` há instantes): o global ganha ao ritmo próprio (5).
    expect(await claim(fast, 1, new Date(at.getTime() + 61_000))).toMatchObject({ kind: "rate_limited", limit: "per_minute" });
  });

  it("pauses (blocked) when the confirmer's quota is exhausted or the confirmer is inactive", async () => {
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 1 } });
    const campaign = await campaignWithRecipients(null, 2);
    const at = new Date();
    expect((await claim(campaign, 1000, at)).kind).toBe("claimed");
    expect(await claim(campaign, 1000, at)).toMatchObject({ kind: "blocked", code: "USER_QUOTA_EXHAUSTED", message: expect.stringMatching(/1 de 1/) });
    await prisma.user.update({ where: { id: actors.operator.id }, data: { dailyPartsLimit: 100, isActive: false } });
    expect(await claim(campaign, 1000, at)).toMatchObject({ kind: "blocked", code: "CONFIRMER_INACTIVE" });
    expect(await prisma.campaignRecipient.count({ where: { campaignId: campaign, status: "PENDING" } })).toBe(1);
  });
});
