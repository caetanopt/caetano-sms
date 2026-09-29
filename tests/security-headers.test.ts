import { describe, expect, it } from "vitest";
import { securityHeaders } from "../src/lib/http/security-headers";

const get = (headers: Array<{ key: string; value: string }>, key: string) => headers.find((h) => h.key === key)?.value;

describe("securityHeaders", () => {
  it("denies framing, sniffing and external resources", () => {
    const headers = securityHeaders(true);
    expect(get(headers, "X-Frame-Options")).toBe("DENY");
    expect(get(headers, "X-Content-Type-Options")).toBe("nosniff");
    const csp = get(headers, "Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(get(headers, "Strict-Transport-Security")).toMatch(/max-age=31536000/);
  });

  it("relaxes only what development needs and never sends HSTS", () => {
    const headers = securityHeaders(false);
    expect(get(headers, "Content-Security-Policy")).toContain("'unsafe-eval'");
    expect(get(headers, "Strict-Transport-Security")).toBeUndefined();
  });
});
