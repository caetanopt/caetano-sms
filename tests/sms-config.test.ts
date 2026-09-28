import { describe, expect, it } from "vitest";
import { getSmsRuntimeConfig, maskOriginationIdentity } from "../src/lib/sms/config";
import { getSmsProvider } from "../src/lib/sms/provider";
import { FakeSmsProvider } from "../src/lib/sms/fake-provider";

describe("getSmsRuntimeConfig", () => {
  it("defaults to fake provider in test mode", () => {
    expect(getSmsRuntimeConfig({})).toMatchObject({ provider: "fake", dryRun: true, mode: "TEST" });
  });

  it("stays in TEST mode with fake provider even if dry-run is disabled", () => {
    expect(getSmsRuntimeConfig({ SMS_PROVIDER: "fake", AWS_SMS_DRY_RUN: "false" }).mode).toBe("TEST");
  });

  it("stays in TEST mode with aws provider unless dry-run is explicitly false", () => {
    expect(getSmsRuntimeConfig({ SMS_PROVIDER: "aws" }).mode).toBe("TEST");
    expect(getSmsRuntimeConfig({ SMS_PROVIDER: "aws", AWS_SMS_DRY_RUN: "false" }).mode).toBe("PRODUCTION");
  });

  it("rejects unknown providers", () => {
    expect(() => getSmsRuntimeConfig({ SMS_PROVIDER: "twilio" })).toThrow();
  });

  it("masks the origination identity", () => {
    expect(getSmsRuntimeConfig({ SMS_PROVIDER: "aws", AWS_SMS_ORIGINATION_IDENTITY: "+351912345678" }).originationLabel).toBe(
      "+351******678",
    );
  });
});

describe("maskOriginationIdentity", () => {
  it("shows short sender IDs, masks long identifiers", () => {
    expect(maskOriginationIdentity("CAETANO")).toBe("CAETANO");
    expect(maskOriginationIdentity("pool-1234567890abcdef")).toBe("pool…cdef");
    expect(maskOriginationIdentity(undefined)).toBe("não configurada");
  });
});

describe("getSmsProvider", () => {
  it("returns the fake provider by default", () => {
    expect(getSmsProvider({})).toBeInstanceOf(FakeSmsProvider);
  });

  it("throws a configuration error for aws without region/identity", () => {
    expect(() => getSmsProvider({ SMS_PROVIDER: "aws" })).toThrow(/AWS_REGION/);
  });
});
