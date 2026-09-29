import { describe, expect, it } from "vitest";
import { clientIpFromHeaders, evaluateLoginThrottle, LOGIN_WINDOW_MS } from "../src/features/auth/login-throttle";

const now = new Date("2026-09-29T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("evaluateLoginThrottle", () => {
  it("allows up to 4 recent failures per email", () => {
    expect(evaluateLoginThrottle({ now, emailFailures: [1, 2, 3, 4].map((m) => ago(m * 60_000)), ipFailures: [] })).toEqual({
      allowed: true,
    });
  });

  it("blocks the 6th attempt until the 5th most recent failure leaves the window", () => {
    const failures = [1, 2, 3, 4, 5].map((m) => ago(m * 60_000));
    expect(evaluateLoginThrottle({ now, emailFailures: failures, ipFailures: [] })).toEqual({
      allowed: false,
      retryAfterMs: LOGIN_WINDOW_MS - 5 * 60_000,
    });
  });

  it("blocks an IP after 20 failures across accounts", () => {
    const failures = Array.from({ length: 20 }, (_, i) => ago(i * 1_000));
    expect(evaluateLoginThrottle({ now, emailFailures: [], ipFailures: failures }).allowed).toBe(false);
  });
});

describe("clientIpFromHeaders", () => {
  const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
  it("ignores X-Forwarded-For unless the proxy is trusted", () => {
    expect(clientIpFromHeaders(headers, false)).toBeNull();
    expect(clientIpFromHeaders(headers, true)).toBe("203.0.113.7");
  });
  it("rejects garbage", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "<script>" }), true)).toBeNull();
  });
});
