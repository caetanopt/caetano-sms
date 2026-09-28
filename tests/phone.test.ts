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
});
