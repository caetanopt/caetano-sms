import { describe, expect, it } from "vitest";
import { estimateMinSendSeconds, formatDuration } from "@/features/rate-limit/estimate";
import { bucketsFor, destinationCountry, getSendRateConfig, parseCountryMps } from "@/features/rate-limit/rules";
import {
  FACTOR_RECOVERY_PER_SECOND,
  initialBucket,
  MIN_FACTOR,
  penalize,
  refill,
  tryConsume,
  waitMs,
} from "@/features/rate-limit/token-bucket";

const t0 = new Date("2026-09-29T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const rule = { ratePerSecond: 2, capacity: 4 };

describe("token bucket", () => {
  it("starts full and allows a burst up to the capacity", () => {
    let state = initialBucket(rule, t0);
    for (let i = 0; i < 4; i += 1) {
      const result = tryConsume(state, rule, 1, t0);
      expect(result.ok).toBe(true);
      state = result.state;
    }
    const blocked = tryConsume(state, rule, 1, t0);
    expect(blocked).toMatchObject({ ok: false, retryAfterMs: 500 });
  });

  it("refills at the configured rate and never above capacity", () => {
    const empty = { tokens: 0, rateFactor: 1, updatedAt: t0 };
    expect(refill(empty, rule, at(1_000)).tokens).toBeCloseTo(2);
    expect(refill(empty, rule, at(60_000)).tokens).toBe(4);
    // Relógio a andar para trás não cria tokens.
    expect(refill(empty, rule, at(-5_000)).tokens).toBe(0);
  });

  it("charges multipart messages by parts, going into debt when larger than the capacity", () => {
    const full = initialBucket(rule, t0);
    const big = tryConsume(full, rule, 10, t0);
    expect(big.ok).toBe(true);
    if (!big.ok) return;
    expect(big.state.tokens).toBe(-6);
    // Precisa de voltar a 1 token: 7 tokens a 2/s = 3,5 s.
    expect(tryConsume(big.state, rule, 1, t0)).toMatchObject({ ok: false, retryAfterMs: 3_500 });
    expect(tryConsume(big.state, rule, 1, at(3_500)).ok).toBe(true);
  });

  it("does not consume from a bucket when blocked", () => {
    const state = { tokens: 0.5, rateFactor: 1, updatedAt: t0 };
    const result = tryConsume(state, rule, 1, t0);
    expect(result.ok).toBe(false);
    expect(result.state.tokens).toBe(0.5);
  });

  it("halves the rate after throttling and recovers linearly", () => {
    const throttled = penalize(initialBucket(rule, t0), rule, t0);
    expect(throttled).toMatchObject({ tokens: 0, rateFactor: 0.5 });
    // Metade do ritmo: 1 token demora 1 s (em vez de 0,5 s).
    expect(waitMs(throttled, rule, 1)).toBe(1_000);
    const again = penalize(penalize(penalize(throttled, rule, t0), rule, t0), rule, t0);
    expect(again.rateFactor).toBe(MIN_FACTOR);

    const recoveryMs = (0.5 / FACTOR_RECOVERY_PER_SECOND) * 1000;
    const recovered = refill(throttled, rule, at(recoveryMs));
    expect(recovered.rateFactor).toBe(1);
    expect(recovered.tokens).toBe(4);
    // 1 s após o throttling: fator 0,5→0,52; tokens = 2/s × (0,5 × 1 + 0,02 × 1²/2) = 1,02.
    expect(refill(throttled, rule, at(1_000)).tokens).toBeCloseTo(2 * (0.5 + 0.01));
  });

  it("keeps a debt after throttling", () => {
    const state = { tokens: -3, rateFactor: 1, updatedAt: t0 };
    expect(penalize(state, rule, t0).tokens).toBe(-3);
  });
});

describe("send rate rules", () => {
  it("parses per-country MPS and rejects invalid entries", () => {
    expect(parseCountryMps("PT=5, ES=0.5")).toEqual({ PT: 5, ES: 0.5 });
    expect(parseCountryMps("")).toEqual({});
    expect(() => parseCountryMps("pt=5")).toThrow(/SMS_MPS_BY_COUNTRY/);
    expect(() => parseCountryMps("PT")).toThrow(/SMS_MPS_BY_COUNTRY/);
    expect(() => parseCountryMps("PT=0")).toThrow(/entre/);
    expect(() => parseCountryMps("PT=5=6")).toThrow(/SMS_MPS_BY_COUNTRY/);
  });

  it("uses conservative defaults and validates numbers", () => {
    expect(getSendRateConfig({})).toEqual({ originMps: 1, countryMps: {}, defaultCountryMps: 1, burstSeconds: 1 });
    expect(() => getSendRateConfig({ SMS_MPS_PER_ORIGIN: "abc" })).toThrow(/SMS_MPS_PER_ORIGIN/);
  });

  it("detects the destination country from E.164", () => {
    expect(destinationCountry("+351912345678")).toBe("PT");
    expect(destinationCountry("+34612345678")).toBe("ES");
    expect(destinationCountry("+999")).toBe("ZZ");
  });

  it("builds an origin bucket and an (origin, country) bucket without storing the identity", () => {
    const config = { originMps: 10, countryMps: { PT: 4 }, defaultCountryMps: 1, burstSeconds: 2 };
    const pt = bucketsFor({ originKey: "arn:aws:sms-voice:eu-west-1:123:sender-id/Caetano", phoneE164: "+351912345678" }, config);
    expect(pt).toHaveLength(2);
    expect(pt[0].rule).toEqual({ ratePerSecond: 10, capacity: 20 });
    expect(pt[1]).toMatchObject({ rule: { ratePerSecond: 4, capacity: 8 }, label: "país PT" });
    expect(pt[1].key).toMatch(/^origin:[0-9a-f]{16}:country:PT$/);
    expect(JSON.stringify(pt)).not.toContain("Caetano");

    const es = bucketsFor({ originKey: "arn:aws:sms-voice:eu-west-1:123:sender-id/Caetano", phoneE164: "+34612345678" }, config);
    expect(es[0].key).toBe(pt[0].key);
    expect(es[1]).toMatchObject({ rule: { ratePerSecond: 1, capacity: 2 } });
    // Capacidade mínima de 1 parte mesmo com MPS fracionário.
    expect(bucketsFor({ originKey: "x", phoneE164: "+351912345678" }, { ...config, countryMps: { PT: 0.2 } })[1].rule.capacity).toBe(1);
  });
});

describe("estimateMinSendSeconds", () => {
  const base = { originMps: 10, countryMps: { PT: 2 }, defaultCountryMps: 1, maxPerMinute: 6000 };

  it("takes the tightest limit among origin, country and per-minute", () => {
    expect(estimateMinSendSeconds({ ...base, messages: 100, segmentsByCountry: { PT: 100 } })).toBe(50);
    expect(estimateMinSendSeconds({ ...base, messages: 100, segmentsByCountry: { PT: 20, ES: 10 } })).toBe(10);
    expect(estimateMinSendSeconds({ ...base, maxPerMinute: 60, messages: 120, segmentsByCountry: { PT: 2 } })).toBe(120);
    expect(estimateMinSendSeconds({ ...base, messages: 0, segmentsByCountry: {} })).toBe(0);
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(61)).toBe("2 min");
    expect(formatDuration(7_500)).toBe("2 h 5 min");
  });
});
