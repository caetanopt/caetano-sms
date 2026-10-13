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

  it("keeps é à ü Ç ñ in GSM_7 but not á/ã", () => {
    const result = getSmsSegmentInfo("Olá? Não: é à ü Ç");
    // "á" e "ã" não pertencem ao alfabeto GSM 03.38
    expect(result.encoding).toBe("UCS_2");
    expect(getSmsSegmentInfo("é à ü Ç ñ").encoding).toBe("GSM_7");
  });

  it("switches Portuguese text with ã/õ/ç/ê to UCS-2", () => {
    for (const text of ["ação", "limões", "caçar", "você"]) {
      expect(getSmsSegmentInfo(text).encoding).toBe("UCS_2");
    }
  });

  it("counts every GSM extension character as two septets", () => {
    const extension = "^{}\\[]~|€";
    const result = getSmsSegmentInfo(extension);
    expect(result.encoding).toBe("GSM_7");
    expect(result.characters).toBe(9);
    expect(result.units).toBe(18);
  });

  it("splits into a new GSM segment when an extension character crosses 160", () => {
    expect(getSmsSegmentInfo("A".repeat(158) + "€").segments).toBe(1);
    expect(getSmsSegmentInfo("A".repeat(159) + "€").segments).toBe(2);
  });

  it("reports remaining septets in the current segment", () => {
    expect(getSmsSegmentInfo("A".repeat(150)).remainingInSegment).toBe(10);
    expect(getSmsSegmentInfo("A".repeat(161)).remainingInSegment).toBe(306 - 161);
  });

  it("uses 153-septet segments for multipart GSM", () => {
    expect(getSmsSegmentInfo("A".repeat(306)).segments).toBe(2);
    expect(getSmsSegmentInfo("A".repeat(307)).segments).toBe(3);
  });

  it("uses 70/67 unit segments for UCS-2", () => {
    expect(getSmsSegmentInfo("ã".repeat(70)).segments).toBe(1);
    expect(getSmsSegmentInfo("ã".repeat(71)).segments).toBe(2);
    expect(getSmsSegmentInfo("ã".repeat(134)).segments).toBe(2);
    expect(getSmsSegmentInfo("ã".repeat(135)).segments).toBe(3);
  });

  it("counts characters outside the BMP (emoji) as two UCS-2 units", () => {
    const result = getSmsSegmentInfo("👋".repeat(35));
    expect(result.characters).toBe(35);
    expect(result.units).toBe(70);
    expect(result.segments).toBe(1);
    expect(getSmsSegmentInfo("👋".repeat(36)).segments).toBe(2);
  });

  it("accepts messages exactly at the limits", () => {
    expect(() => assertSmsLength("A".repeat(1530))).not.toThrow();
    expect(() => assertSmsLength("ã".repeat(630))).not.toThrow();
  });

  it("rejects UCS-2 messages above 630 units", () => {
    expect(() => assertSmsLength("ã".repeat(631))).toThrow();
    expect(() => assertSmsLength("👋".repeat(316))).toThrow();
  });

  it("counts extension characters toward the GSM limit", () => {
    expect(() => assertSmsLength("€".repeat(765))).not.toThrow();
    expect(() => assertSmsLength("€".repeat(766))).toThrow();
  });
});
