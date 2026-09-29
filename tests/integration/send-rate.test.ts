import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { recordProviderThrottle, reserveSendCapacity, type SendRateLimits } from "@/server/services/send-rate";
import { resetDatabase } from "./helpers";

const PT = "+351912345678";
const ES = "+34612345678";
const t0 = new Date("2026-09-29T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

const limits = (overrides: Partial<SendRateLimits["rate"]> = {}): SendRateLimits => ({
  maxPerMinute: 1000,
  originKey: "origin-a",
  rate: { originMps: 10, countryMps: { PT: 2 }, defaultCountryMps: 1, burstSeconds: 1, ...overrides },
});

beforeEach(resetDatabase);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("reserveSendCapacity (MPS)", () => {
  it("limits parts per second per destination country", async () => {
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, limits(), t0)).toEqual({ ok: true });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, limits(), t0)).toEqual({ ok: true });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, limits(), t0)).toMatchObject({
      ok: false,
      limit: "mps",
      label: "país PT",
      retryAfterMs: 500,
    });
    // Outro país tem balde próprio.
    expect(await reserveSendCapacity({ phoneE164: ES, segments: 1 }, limits(), t0)).toEqual({ ok: true });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, limits(), at(500))).toEqual({ ok: true });
  });

  it("limits the origination identity across countries, all-or-nothing", async () => {
    const config = limits({ originMps: 2, countryMps: { PT: 10, ES: 10 } });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, config, t0)).toEqual({ ok: true });
    expect(await reserveSendCapacity({ phoneE164: ES, segments: 1 }, config, t0)).toEqual({ ok: true });
    expect(await reserveSendCapacity({ phoneE164: ES, segments: 1 }, config, t0)).toMatchObject({ ok: false, label: "identidade de origem" });
    // O bloqueio pela origem não consumiu o balde do país.
    const es = await prisma.sendRateBucket.findFirstOrThrow({ where: { key: { endsWith: ":country:ES" } } });
    expect(es.tokens).toBe(9);
    // Outra identidade de origem é independente.
    expect(await reserveSendCapacity({ phoneE164: ES, segments: 1 }, { ...config, originKey: "origin-b" }, t0)).toEqual({ ok: true });
  });

  it("charges by message parts", async () => {
    const config = limits({ countryMps: { PT: 3 } });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 3 }, config, t0)).toEqual({ ok: true });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, config, t0)).toMatchObject({ ok: false, retryAfterMs: 334 });
  });

  it("still applies the per-minute limit", async () => {
    const result = await reserveSendCapacity({ phoneE164: PT, segments: 1 }, { ...limits(), maxPerMinute: 0 }, t0);
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
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, limits(), at(500))).toMatchObject({ ok: false, limit: "mps" });
    expect(await reserveSendCapacity({ phoneE164: PT, segments: 1 }, limits(), at(1_000))).toEqual({ ok: true });
  });

  it("serializes concurrent reservations (no overbooking)", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => reserveSendCapacity({ phoneE164: PT, segments: 1 }, limits(), t0)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });
});
