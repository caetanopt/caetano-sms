import {
  AccessDeniedException,
  ConflictException,
  InternalServerException,
  ResourceNotFoundException,
  ServiceQuotaExceededException,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { describe, expect, it } from "vitest";
import { mapAwsSmsError } from "../src/lib/sms/aws-errors";

const metadata = { $metadata: { requestId: "req-123", httpStatusCode: 400 } };

describe("mapAwsSmsError", () => {
  it("maps throttling to a retryable, certain failure", () => {
    const result = mapAwsSmsError(new ThrottlingException({ message: "slow down", ...metadata }));
    expect(result).toMatchObject({
      errorCode: "THROTTLED",
      retryable: true,
      uncertain: false,
      providerErrorName: "ThrottlingException",
      providerRequestId: "req-123",
    });
  });

  it.each([
    ["DESTINATION_PHONE_NUMBER_OPTED_OUT", "OPTED_OUT"],
    ["DESTINATION_COUNTRY_BLOCKED_BY_PROTECT_CONFIGURATION", "PROTECT_BLOCKED"],
    ["DESTINATION_PHONE_NUMBER_BLOCKED_BY_PROTECT_NUMBER_OVERRIDE", "PROTECT_BLOCKED"],
    ["DESTINATION_PHONE_NUMBER_NOT_VERIFIED", "DESTINATION_NOT_VERIFIED"],
    ["MESSAGE_TYPE_MISMATCH", "CONFIGURATION_ERROR"],
  ] as const)("maps ConflictException %s to %s (not retryable)", (reason, code) => {
    const result = mapAwsSmsError(new ConflictException({ message: "x", Reason: reason, ...metadata }));
    expect(result).toMatchObject({ errorCode: code, retryable: false, uncertain: false });
  });

  it.each([
    ["DESTINATION_COUNTRY_BLOCKED", "PROTECT_BLOCKED"],
    ["PRICE_OVER_THRESHOLD", "SPEND_LIMIT"],
    ["SENDER_ID_NOT_REGISTERED", "CONFIGURATION_ERROR"],
    ["INVALID_IDENTITY_FOR_DESTINATION_COUNTRY", "CONFIGURATION_ERROR"],
    ["MAXIMUM_SIZE_EXCEEDED", "VALIDATION_ERROR"],
  ] as const)("maps ValidationException %s to %s", (reason, code) => {
    const result = mapAwsSmsError(new ValidationException({ message: "x", Reason: reason, ...metadata }));
    expect(result).toMatchObject({ errorCode: code, retryable: false, uncertain: false });
  });

  it("detects invalid destination numbers from validation fields", () => {
    const result = mapAwsSmsError(
      new ValidationException({
        message: "x",
        Reason: "FIELD_VALIDATION_FAILED",
        Fields: [{ Name: "DestinationPhoneNumber", Message: "invalid" }],
        ...metadata,
      }),
    );
    expect(result.errorCode).toBe("INVALID_PHONE_NUMBER");
    expect(result.retryable).toBe(false);
  });

  it("maps monthly spend limit and other quotas", () => {
    expect(
      mapAwsSmsError(
        new ServiceQuotaExceededException({ message: "x", Reason: "MONTHLY_SPEND_LIMIT_REACHED_FOR_TEXT", ...metadata }),
      ).errorCode,
    ).toBe("SPEND_LIMIT");
    expect(
      mapAwsSmsError(
        new ServiceQuotaExceededException({ message: "x", Reason: "DAILY_DESTINATION_CALL_LIMIT", ...metadata }),
      ).errorCode,
    ).toBe("QUOTA_EXCEEDED");
  });

  it("maps access denied and credential errors to AUTH_ERROR", () => {
    expect(mapAwsSmsError(new AccessDeniedException({ message: "x", ...metadata })).errorCode).toBe("AUTH_ERROR");
    const credentials = Object.assign(new Error("Could not load credentials"), { name: "CredentialsProviderError" });
    expect(mapAwsSmsError(credentials)).toMatchObject({ errorCode: "AUTH_ERROR", uncertain: false });
  });

  it("maps missing resources to CONFIGURATION_ERROR", () => {
    expect(mapAwsSmsError(new ResourceNotFoundException({ message: "x", ...metadata })).errorCode).toBe(
      "CONFIGURATION_ERROR",
    );
  });

  it("treats internal server errors as uncertain and never retryable", () => {
    const result = mapAwsSmsError(new InternalServerException({ message: "x", ...metadata }));
    expect(result).toMatchObject({ errorCode: "PROVIDER_UNAVAILABLE", uncertain: true, retryable: false });
  });

  it("treats timeouts and unknown errors as uncertain", () => {
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    expect(mapAwsSmsError(timeout)).toMatchObject({ errorCode: "UNKNOWN", uncertain: true, retryable: false });
    expect(mapAwsSmsError("weird")).toMatchObject({ errorCode: "UNKNOWN", uncertain: true });
  });

  it("treats connection refused as retryable (request never left)", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(mapAwsSmsError(refused)).toMatchObject({
      errorCode: "PROVIDER_UNAVAILABLE",
      retryable: true,
      uncertain: false,
    });
  });

  it("never exposes the SDK message or stack in the safe message", () => {
    const error = new ValidationException({ message: "secret-internal-detail AKIA123", ...metadata });
    const result = mapAwsSmsError(error);
    expect(result.errorMessage).not.toContain("secret-internal-detail");
    expect(JSON.stringify(result)).not.toContain("AKIA123");
    expect(JSON.stringify(result)).not.toMatch(/\\n\s+at /);
  });
});
