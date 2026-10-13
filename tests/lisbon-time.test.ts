import { describe, expect, it } from "vitest";
import { endOfLisbonDay, lisbonDayKey, lisbonDayWindow, startOfLisbonDay } from "../src/lib/time/lisbon";

describe("Lisbon day boundaries", () => {
  it("uses UTC+0 in winter and UTC+1 in summer", () => {
    expect(startOfLisbonDay("2026-01-15")?.toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(startOfLisbonDay("2026-07-01")?.toISOString()).toBe("2026-06-30T23:00:00.000Z");
  });

  it("handles DST change days (23h and 25h days)", () => {
    // 2026-03-29: Lisboa muda de UTC+0 para UTC+1 às 01:00 UTC.
    expect(startOfLisbonDay("2026-03-29")?.toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(endOfLisbonDay("2026-03-29")?.toISOString()).toBe("2026-03-29T23:00:00.000Z");
    // 2026-10-25: volta a UTC+0.
    expect(startOfLisbonDay("2026-10-25")?.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(endOfLisbonDay("2026-10-25")?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("rejects invalid dates", () => {
    expect(startOfLisbonDay("2026-02-30")).toBeNull();
    expect(startOfLisbonDay("29/09/2026")).toBeNull();
    expect(startOfLisbonDay("")).toBeNull();
  });
});

describe("lisbonDayKey / lisbonDayWindow", () => {
  it("uses the Lisbon civil day (winter and summer)", () => {
    expect(lisbonDayKey(new Date("2026-01-15T23:30:00Z"))).toBe("2026-01-15");
    expect(lisbonDayKey(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(lisbonDayWindow(new Date("2026-10-24T23:00:00Z")).day).toBe("2026-10-25");
  });

  it("accepts 23 h and 25 h days around DST changes", () => {
    const spring = lisbonDayWindow(new Date("2026-03-29T12:00:00Z"));
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * 3_600_000);
    const autumn = lisbonDayWindow(new Date("2026-10-25T12:00:00Z"));
    expect(autumn.end.getTime() - autumn.start.getTime()).toBe(25 * 3_600_000);
    expect(autumn.start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(autumn.end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });
});
