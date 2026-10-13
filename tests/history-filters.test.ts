import { describe, expect, it } from "vitest";
import { historyDateRange, historyQueryString, parseHistoryFilters } from "../src/features/messages/history-filters";

describe("parseHistoryFilters", () => {
  it("keeps only recognised values", () => {
    expect(
      parseHistoryFilters({
        status: "ACCEPTED",
        type: "PROMOTIONAL",
        campaignId: "cmul9iznu0000377dl1isffbq",
        from: "2026-09-01",
        to: "2026-09-30",
        q: " Maria ",
        page: "2",
      }),
    ).toEqual({
      status: "ACCEPTED",
      type: "PROMOTIONAL",
      campaignId: "cmul9iznu0000377dl1isffbq",
      from: "2026-09-01",
      to: "2026-09-30",
      q: "Maria",
      page: 2,
    });
  });

  it("drops invalid values", () => {
    expect(
      parseHistoryFilters({ status: "DELETE", type: "x", campaignId: "'; drop", from: "2026-13-01", page: "-1" }),
    ).toEqual({ page: 1, status: undefined, type: undefined, campaignId: undefined, from: undefined, to: undefined, q: undefined });
  });
});

describe("historyDateRange", () => {
  it("converts Lisbon days to a UTC half-open interval", () => {
    expect(historyDateRange({ from: "2026-07-01", to: "2026-07-01" })).toEqual({
      gte: new Date("2026-06-30T23:00:00.000Z"),
      lt: new Date("2026-07-01T23:00:00.000Z"),
    });
  });
});

describe("historyQueryString", () => {
  it("preserves filters across pages", () => {
    expect(historyQueryString({ status: "FAILED", page: 1 }, 3)).toBe("?status=FAILED&page=3");
    expect(historyQueryString({ page: 1 })).toBe("");
  });
});
