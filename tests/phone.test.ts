import { describe, expect, it } from "vitest";
import { maskPhoneNumber, normalizePhoneNumber } from "../src/lib/phone/normalize";

describe("phone utilities", () => {
  it("normalizes a Portuguese mobile number", () => {
    expect(normalizePhoneNumber("912 345 678")).toBe("+351912345678");
  });

  it("rejects invalid numbers", () => {
    expect(() => normalizePhoneNumber("123")).toThrow();
  });

  it("masks a phone number", () => {
    expect(maskPhoneNumber("+351912345678")).toBe("+351******678");
  });

  it("accepts already-normalized E.164 and formatted input", () => {
    expect(normalizePhoneNumber("+351 912 345 678")).toBe("+351912345678");
    expect(normalizePhoneNumber("00351912345678")).toBe("+351912345678");
    expect(normalizePhoneNumber("  912-345-678 ")).toBe("+351912345678");
  });

  it("does not force PT for international numbers", () => {
    expect(normalizePhoneNumber("+34 612 345 678")).toBe("+34612345678");
  });

  it("rejects numbers that are not possible for the country", () => {
    expect(() => normalizePhoneNumber("+351 12345")).toThrow();
    expect(() => normalizePhoneNumber("abc")).toThrow();
  });
});
