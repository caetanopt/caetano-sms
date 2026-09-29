import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/http/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // Importação CSV: o ficheiro (máx. 2 MB, validado no servidor) segue no corpo da action.
      bodySizeLimit: "3mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env.NODE_ENV === "production") }];
  },
};

export default nextConfig;
