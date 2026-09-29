import { describe, expect, it } from "vitest";
import { EMPTY_RECIPIENT_COUNTS, finalCampaignStatus, retryDelayMs } from "../src/features/campaigns/processing-rules";

describe("retryDelayMs", () => {
  it("grows exponentially with ±30% jitter and a cap", () => {
    expect(retryDelayMs(1, () => 0.5)).toBe(5_000);
    expect(retryDelayMs(2, () => 0.5)).toBe(10_000);
    expect(retryDelayMs(3, () => 0.5)).toBe(20_000);
    expect(retryDelayMs(1, () => 0)).toBe(3_500);
    expect(retryDelayMs(1, () => 1)).toBe(6_500);
    expect(retryDelayMs(20, () => 0.5)).toBe(300_000);
  });
});

describe("finalCampaignStatus", () => {
  const counts = (overrides: Partial<typeof EMPTY_RECIPIENT_COUNTS>) => ({ ...EMPTY_RECIPIENT_COUNTS, ...overrides });

  it("is not final while recipients are pending or in flight", () => {
    expect(finalCampaignStatus(counts({ PENDING: 1, ACCEPTED: 3 }))).toBeNull();
    expect(finalCampaignStatus(counts({ PROCESSING: 1 }))).toBeNull();
  });

  it("classifies completed, partial and failed campaigns", () => {
    expect(finalCampaignStatus(counts({ ACCEPTED: 3, SKIPPED: 2, CANCELLED: 1 }))).toBe("COMPLETED");
    expect(finalCampaignStatus(counts({ ACCEPTED: 3, FAILED: 1 }))).toBe("PARTIAL");
    expect(finalCampaignStatus(counts({ ACCEPTED: 3, UNKNOWN: 1 }))).toBe("PARTIAL");
    expect(finalCampaignStatus(counts({ FAILED: 2, UNKNOWN: 1 }))).toBe("FAILED");
    // Nada enviado nunca é apresentado como sucesso.
    expect(finalCampaignStatus(counts({ SKIPPED: 2 }))).toBe("FAILED");
    expect(finalCampaignStatus(counts({ CANCELLED: 1 }))).toBe("FAILED");
  });
});
