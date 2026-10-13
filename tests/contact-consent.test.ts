import { describe, expect, it } from "vitest";
import { planConsentChange, resolveInitialConsent, type CurrentConsent } from "../src/features/contacts/consent";
import { can } from "../src/lib/auth/permissions";

const now = new Date("2026-09-28T10:00:00Z");
const unknown: CurrentConsent = { consentStatus: "UNKNOWN", optedOutAt: null, suppressed: false };
const optedOut: CurrentConsent = { consentStatus: "OPTED_OUT", optedOutAt: new Date("2026-01-01"), suppressed: true };
const details = { source: "loja", purpose: "marketing" };

describe("permissions", () => {
  it("gives VIEWER no write permissions", () => {
    for (const permission of ["contacts:write", "contacts:import", "lists:write", "sms:send"] as const) {
      expect(can("VIEWER", permission)).toBe(false);
      expect(can("OPERATOR", permission)).toBe(true);
    }
  });

  it("reserves deletion and re-opt-in for ADMIN", () => {
    expect(can("OPERATOR", "contacts:delete")).toBe(false);
    expect(can("OPERATOR", "contacts:reopt-in")).toBe(false);
    expect(can("ADMIN", "contacts:delete")).toBe(true);
    expect(can("ADMIN", "contacts:reopt-in")).toBe(true);
  });
});

describe("planConsentChange", () => {
  it("allows opt-out and adds to the suppression list", () => {
    const plan = planConsentChange({ current: unknown, to: "OPTED_OUT", details: {}, role: "OPERATOR", now });
    expect(plan).toMatchObject({
      ok: true,
      noop: false,
      change: { status: "OPTED_OUT", optedOutAt: now, suppression: "add", consentSource: "manual" },
    });
  });

  it("is a no-op when already fully opted out", () => {
    const plan = planConsentChange({ current: optedOut, to: "OPTED_OUT", details: {}, role: "ADMIN", now });
    expect(plan).toEqual({ ok: true, noop: true });
  });

  it("requires source and purpose for opt-in", () => {
    expect(planConsentChange({ current: unknown, to: "OPTED_IN", details: {}, role: "OPERATOR", now })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/origem/),
    });
    expect(
      planConsentChange({ current: unknown, to: "OPTED_IN", details: { source: "loja" }, role: "OPERATOR", now }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/finalidade/) });
  });

  it("records opt-in with timestamp and clears opt-out", () => {
    const plan = planConsentChange({ current: unknown, to: "OPTED_IN", details, role: "OPERATOR", now });
    expect(plan).toMatchObject({
      ok: true,
      change: { status: "OPTED_IN", consentAt: now, consentSource: "loja", optedOutAt: null, suppression: "remove" },
    });
  });

  it("only lets ADMIN re-opt-in an opted-out or suppressed number", () => {
    expect(planConsentChange({ current: optedOut, to: "OPTED_IN", details, role: "OPERATOR", now }).ok).toBe(false);
    const suppressedOnly = { ...unknown, suppressed: true };
    expect(planConsentChange({ current: suppressedOnly, to: "OPTED_IN", details, role: "OPERATOR", now }).ok).toBe(false);
    expect(planConsentChange({ current: optedOut, to: "OPTED_IN", details, role: "ADMIN", now }).ok).toBe(true);
  });

  it("denies VIEWER any change", () => {
    expect(planConsentChange({ current: unknown, to: "OPTED_OUT", details: {}, role: "VIEWER", now }).ok).toBe(false);
  });
});

describe("resolveInitialConsent", () => {
  it("requires source and purpose for OPTED_IN", () => {
    expect(resolveInitialConsent({ requested: "OPTED_IN", details: {}, suppressed: false }).ok).toBe(false);
    expect(resolveInitialConsent({ requested: "OPTED_IN", details, suppressed: false })).toMatchObject({
      ok: true,
      status: "OPTED_IN",
    });
  });

  it("forces OPTED_OUT for suppressed numbers", () => {
    expect(resolveInitialConsent({ requested: "OPTED_IN", details, suppressed: true })).toMatchObject({
      ok: true,
      status: "OPTED_OUT",
      warning: expect.stringMatching(/suppression/),
    });
  });

  it("creates UNKNOWN without a consent record", () => {
    expect(resolveInitialConsent({ requested: "UNKNOWN", details: {}, suppressed: false })).toEqual({
      ok: true,
      status: "UNKNOWN",
      details: null,
    });
  });
});
