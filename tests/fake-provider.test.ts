import { describe, expect, it } from "vitest";
import { FakeSmsProvider, fakeSmsProviderOptionsFromEnv } from "../src/lib/sms/fake-provider";

const input = {
  destinationPhoneNumber: "+351912345678",
  messageBody: "Teste",
  messageType: "TRANSACTIONAL" as const,
};

describe("FakeSmsProvider", () => {
  it("accepts E.164 numbers without calling AWS", async () => {
    const result = await new FakeSmsProvider().send(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("fake");
      expect(result.messageId).toMatch(/^fake_/);
    }
  });

  it("rejects non-E.164 numbers as non-retryable", async () => {
    const result = await new FakeSmsProvider().send({ ...input, destinationPhoneNumber: "912345678" });
    expect(result).toMatchObject({ ok: false, errorCode: "INVALID_PHONE_NUMBER", retryable: false });
  });

  it.each([
    ["failure", "VALIDATION_ERROR", false, false],
    ["throttle", "THROTTLED", true, false],
    ["opt_out", "OPTED_OUT", false, false],
    ["uncertain", "UNKNOWN", false, true],
  ] as const)("simulates %s", async (scenario, errorCode, retryable, uncertain) => {
    const result = await new FakeSmsProvider({ scenario }).send(input);
    expect(result).toMatchObject({ ok: false, errorCode, retryable, uncertain });
  });

  it("simulates latency", async () => {
    const started = Date.now();
    await new FakeSmsProvider({ delayMs: 50 }).send(input);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });
});

describe("fakeSmsProviderOptionsFromEnv", () => {
  it("defaults to success without delay", () => {
    expect(fakeSmsProviderOptionsFromEnv({})).toEqual({ scenario: "success", delayMs: 0 });
  });

  it("reads scenario and delay", () => {
    expect(fakeSmsProviderOptionsFromEnv({ SMS_FAKE_SCENARIO: "throttle", SMS_FAKE_DELAY_MS: "200" })).toEqual({
      scenario: "throttle",
      delayMs: 200,
    });
  });

  it("rejects invalid values", () => {
    expect(() => fakeSmsProviderOptionsFromEnv({ SMS_FAKE_SCENARIO: "boom" })).toThrow();
    expect(() => fakeSmsProviderOptionsFromEnv({ SMS_FAKE_DELAY_MS: "-1" })).toThrow();
    expect(() => fakeSmsProviderOptionsFromEnv({ SMS_FAKE_DELAY_MS: "abc" })).toThrow();
  });
});
