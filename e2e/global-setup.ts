import { execSync } from "node:child_process";
import bcrypt from "bcryptjs";

export const E2E_ADMIN = { email: "e2e-admin@example.com", password: "e2e-admin-password-123" };
export const E2E_VIEWER = { email: "e2e-viewer@example.com", password: "e2e-viewer-password-123" };

export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL é obrigatório para os testes E2E (a base de dados é apagada).");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL não pode ser igual a DATABASE_URL.");
  execSync("pnpm -s prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

  process.env.DATABASE_URL = url;
  const { prisma } = await import("../src/lib/db/prisma");
  await prisma.$executeRawUnsafe(
    'TRUNCATE "CampaignRecipient", "Campaign", "ContactListMember", "ContactList", "ConsentEvent", "SuppressionEntry", "SmsDeliveryEvent", "SmsMessage", "SmsTemplate", "AuditLog", "Contact", "User" CASCADE',
  );
  for (const [user, role, name] of [
    [E2E_ADMIN, "ADMIN", "Admin E2E"],
    [E2E_VIEWER, "VIEWER", "Leitor E2E"],
  ] as const) {
    await prisma.user.create({
      data: { email: user.email, name, role, passwordHash: await bcrypt.hash(user.password, 10) },
    });
  }
  await prisma.$disconnect();
}
