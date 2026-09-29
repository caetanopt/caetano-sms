import "dotenv/config";
import { defineConfig } from "@playwright/test";

const PORT = 3100;
export const E2E_METRICS_TOKEN = "e2e-metrics-token-with-at-least-32-characters";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";

// E2E contra o build de produção, provider fake e base de dados de TESTE (apagada no setup).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm start --port ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATABASE_URL: databaseUrl,
      SMS_PROVIDER: "fake",
      SMS_FAKE_SCENARIO: "success",
      AWS_SMS_DRY_RUN: "true",
      SMS_BULK_CONFIRMATION_THRESHOLD: "1",
      METRICS_TOKEN: E2E_METRICS_TOKEN,
    },
  },
});
