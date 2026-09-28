import { describe, expect, it } from "vitest";
import { assertSmsLength, getSmsSegmentInfo } from "../src/lib/sms/encoding";

describe("getSmsSegmentInfo", () => {
  it("uses one GSM segment up to 160 septets", () => {
    const result = getSmsSegmentInfo("A".repeat(160));
    expect(result.encoding).toBe("GSM_7");
    expect(result.segments).toBe(1);
  });

  it("uses multipart GSM after 160 septets", () => {
    const result = getSmsSegmentInfo("A".repeat(161));
    expect(result.segments).toBe(2);
  });

  it("counts extension characters as two septets", () => {
    const result = getSmsSegmentInfo("€");
    expect(result.encoding).toBe("GSM_7");
    expect(result.units).toBe(2);
  });

  it("switches to UCS-2 for non-GSM characters", () => {
    const result = getSmsSegmentInfo("Olá 👋");
    expect(result.encoding).toBe("UCS_2");
  });

  it("rejects messages above configured SMS limits", () => {
    expect(() => assertSmsLength("A".repeat(1531))).toThrow();
  });
});
