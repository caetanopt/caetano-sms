import { describe, expect, it } from "vitest";
import { checkManualSendEligibility, isOptedOut } from "../src/lib/sms/eligibility";

const optedIn = { consentStatus: "OPTED_IN" as const, optedOutAt: null };
const unknown = { consentStatus: "UNKNOWN" as const, optedOutAt: null };
const optedOut = { consentStatus: "OPTED_OUT" as const, optedOutAt: new Date() };

describe("isOptedOut", () => {
  it("treats optedOutAt as opt-out even if consentStatus says OPTED_IN", () => {
    expect(isOptedOut({ consentStatus: "OPTED_IN", optedOutAt: new Date() })).toBe(true);
  });

  it("treats OPTED_OUT status as opt-out even without optedOutAt", () => {
    expect(isOptedOut({ consentStatus: "OPTED_OUT", optedOutAt: null })).toBe(true);
  });

  it("does not flag opted-in contacts", () => {
    expect(isOptedOut(optedIn)).toBe(false);
  });
});

describe("checkManualSendEligibility", () => {
  it.each(["TRANSACTIONAL", "PROMOTIONAL"] as const)(
    "blocks opted-out contacts for %s messages, even with legal basis confirmed",
    (messageType) => {
      const result = checkManualSendEligibility({
        contact: optedOut,
        messageType,
        legalBasisConfirmed: true,
      });
      expect(result).toMatchObject({ ok: false, reason: "OPTED_OUT" });
    },
  );

  it("blocks promotional sends to known contacts without opt-in", () => {
    const result = checkManualSendEligibility({
      contact: unknown,
      messageType: "PROMOTIONAL",
      legalBasisConfirmed: true,
    });
    expect(result).toMatchObject({ ok: false, reason: "NO_CONSENT" });
  });

  it("allows promotional sends to opted-in contacts", () => {
    const result = checkManualSendEligibility({
      contact: optedIn,
      messageType: "PROMOTIONAL",
      legalBasisConfirmed: false,
    });
    expect(result.ok).toBe(true);
  });

  it("requires legal basis for promotional sends to unknown numbers", () => {
    const result = checkManualSendEligibility({
      contact: null,
      messageType: "PROMOTIONAL",
      legalBasisConfirmed: false,
    });
    expect(result).toMatchObject({ ok: false, reason: "LEGAL_BASIS_REQUIRED" });
  });

  it("allows promotional sends to unknown numbers when legal basis is confirmed", () => {
    const result = checkManualSendEligibility({
      contact: null,
      messageType: "PROMOTIONAL",
      legalBasisConfirmed: true,
    });
    expect(result.ok).toBe(true);
  });

  it("allows transactional sends to unknown numbers", () => {
    const result = checkManualSendEligibility({
      contact: null,
      messageType: "TRANSACTIONAL",
      legalBasisConfirmed: false,
    });
    expect(result.ok).toBe(true);
  });
});
