import { describe, expect, it } from "vitest";
import { parseSmsEvent, replaceableStatuses, TEXT_EVENT_STATUS } from "../src/features/delivery/events";

const event = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    eventType: "TEXT_DELIVERED",
    eventTimestamp: 1_790_000_000_000,
    isFinal: true,
    messageId: "aws-123",
    messageStatus: "DELIVERED",
    totalMessagePrice: 0.0421,
    destinationPhoneNumber: "+351912345678",
    context: { internalMessageId: "cmul9iznu0000377dl1isffbq", campaignId: "x" },
    ...overrides,
  });

describe("parseSmsEvent", () => {
  it("maps the documented TEXT_* events", () => {
    expect(parseSmsEvent(event())).toMatchObject({
      eventType: "TEXT_DELIVERED",
      awsMessageId: "aws-123",
      status: "DELIVERED",
      internalMessageId: "cmul9iznu0000377dl1isffbq",
      isFinal: true,
      priceUsd: 0.0421,
      optedOut: false,
    });
    expect(parseSmsEvent(event({ eventType: "TEXT_PROTECT_BLOCKED" }))?.status).toBe("PROTECT_BLOCKED");
    expect(parseSmsEvent(event({ eventType: "TEXT_CARRIER_UNREACHABLE" }))?.status).toBe("UNROUTABLE");
  });

  it("covers every TEXT_* type exposed by the SDK enum", async () => {
    const enums = await import("@aws-sdk/client-pinpoint-sms-voice-v2");
    const sdkTextTypes = Object.values(enums.EventType).filter((v) => v.startsWith("TEXT_") && v !== "TEXT_ALL");
    expect(sdkTextTypes.sort()).toEqual(Object.keys(TEXT_EVENT_STATUS).sort());
  });

  it("does not keep the phone number and detects provider opt-out", () => {
    const parsed = parseSmsEvent(event({ eventType: "TEXT_BLOCKED", messageStatus: "DESTINATION_PHONE_NUMBER_OPTED_OUT" }));
    expect(JSON.stringify(parsed)).not.toContain("912345678");
    expect(parsed).toMatchObject({ status: "FAILED", optedOut: true });
  });

  it("ignores unknown types, bad JSON and unsafe internal ids", () => {
    expect(parseSmsEvent(event({ eventType: "VOICE_ANSWERED" }))?.status).toBeNull();
    expect(parseSmsEvent("{nope")).toBeNull();
    expect(parseSmsEvent(JSON.stringify({ eventType: "TEXT_DELIVERED" }))).toBeNull();
    expect(parseSmsEvent(event({ context: { internalMessageId: "'; drop" } }))?.internalMessageId).toBeNull();
  });
});

describe("replaceableStatuses", () => {
  it("never downgrades and never overwrites final states", () => {
    expect(replaceableStatuses("QUEUED").sort()).toEqual(["ACCEPTED", "PENDING", "UNKNOWN"]);
    expect(replaceableStatuses("SENT")).toContain("QUEUED");
    expect(replaceableStatuses("DELIVERED").sort()).toEqual(["ACCEPTED", "PENDING", "QUEUED", "SENT", "UNKNOWN"]);
    expect(replaceableStatuses("DELIVERED")).not.toContain("FAILED");
    expect(replaceableStatuses("FAILED")).not.toContain("DELIVERED");
  });

  it("an UNKNOWN event never downgrades QUEUED/SENT", () => {
    expect(replaceableStatuses("UNKNOWN").sort()).toEqual(["ACCEPTED", "PENDING", "UNKNOWN"]);
  });
});
