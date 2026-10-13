import "dotenv/config";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Testes de integração: correm contra uma base de dados PostgreSQL de teste
// (TEST_DATABASE_URL), nunca contra a base de dados de desenvolvimento.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
      SMS_PROVIDER: "fake",
      AWS_SMS_DRY_RUN: "true",
    },
  },
});
