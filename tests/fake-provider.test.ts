import { describe, expect, it } from "vitest";
import { FakeSmsProvider } from "../src/lib/sms/fake-provider";

describe("FakeSmsProvider", () => {
  const provider = new FakeSmsProvider();

  it("accepts E.164 numbers without calling AWS", async () => {
    const result = await provider.send({
      destinationPhoneNumber: "+351912345678",
      messageBody: "Teste",
      messageType: "TRANSACTIONAL",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.provider).toBe("fake");
      expect(result.messageId).toMatch(/^fake_/);
    }
  });

  it("rejects non-E.164 numbers as non-retryable", async () => {
    const result = await provider.send({
      destinationPhoneNumber: "912345678",
      messageBody: "Teste",
      messageType: "TRANSACTIONAL",
    });
    expect(result).toMatchObject({
      ok: false,
      errorCode: "INVALID_PHONE_NUMBER",
      retryable: false,
    });
  });
});
