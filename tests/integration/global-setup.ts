import { execSync } from "node:child_process";

export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL não está definido. Cria uma base de dados de teste (ex.: sms_app_test) e define-o no .env.",
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL não pode ser igual a DATABASE_URL: os testes apagam dados.");
  }
  execSync("pnpm -s prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
}
