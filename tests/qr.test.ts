import { describe, expect, it } from "vitest";
import { QR_QUIET_ZONE, qrMatrix, qrSvgPath } from "@/features/auth/qr";
import { otpauthUri } from "@/features/auth/totp";
import { decodeQrPath } from "./helpers/qr-decode";

describe("QR code for 2FA setup", () => {
  it("renders an SVG path that decodes back to the otpauth URI", () => {
    const uri = otpauthUri({ issuer: "SMS AWS", account: "maria.silva@example.pt", secretBase32: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" });
    const matrix = qrMatrix(uri);
    const path = qrSvgPath(matrix);
    expect(decodeQrPath(path, matrix.size + QR_QUIET_ZONE * 2)).toBe(uri);
  });

  it("keeps the quiet zone and merges horizontal runs", () => {
    const matrix = qrMatrix("otpauth://totp/x?secret=ABC");
    const path = qrSvgPath(matrix);
    const segments = [...path.matchAll(/M(\d+) (\d+)h(\d+)/g)].map((m) => m.slice(1).map(Number));
    expect(segments.length).toBeGreaterThan(0);
    for (const [x, y, w] of segments) {
      expect(x).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(y).toBeGreaterThanOrEqual(QR_QUIET_ZONE);
      expect(x + w).toBeLessThanOrEqual(matrix.size + QR_QUIET_ZONE);
    }
    const darkModules = Array.from({ length: matrix.size ** 2 }, (_, i) => matrix.dark(i % matrix.size, Math.floor(i / matrix.size))).filter(Boolean).length;
    expect(segments.reduce((sum, [, , w]) => sum + w, 0)).toBe(darkModules);
    expect(segments.length).toBeLessThan(darkModules);
  });
});
