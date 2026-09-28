import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // Importação CSV: o ficheiro (máx. 2 MB, validado no servidor) segue no corpo da action.
      bodySizeLimit: "3mb",
    },
  },
};

export default nextConfig;
