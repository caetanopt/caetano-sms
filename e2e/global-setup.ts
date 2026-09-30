import { execSync } from "node:child_process";
import bcrypt from "bcryptjs";

export const E2E_ADMIN = { email: "e2e-admin@example.com", password: "e2e-admin-password-123" };
export const E2E_VIEWER = { email: "e2e-viewer@example.com", password: "e2e-viewer-password-123" };
/** Operador sem 2FA: usado nos testes de quota por utilizador. */
export const E2E_OPERATOR = { email: "e2e-operator@example.com", password: "e2e-operator-password-123" };
/** Segredo TOTP do administrador E2E (2FA é obrigatório para ADMIN). Só para testes. */
export const E2E_ADMIN_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL é obrigatório para os testes E2E (a base de dados é apagada).");
  if (url === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL não pode ser igual a DATABASE_URL.");
  execSync("pnpm -s prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });

  process.env.DATABASE_URL = url;
  const { prisma } = await import("../src/lib/db/prisma");
  await prisma.$executeRawUnsafe(
    'TRUNCATE "CampaignRecipient", "Campaign", "ContactListMember", "ContactList", "ConsentEvent", "SuppressionEntry", "SmsDeliveryEvent", "SmsMessage", "SmsTemplate", "AuditLog", "LoginAttempt", "SendRateBucket", "MfaRecoveryCode", "Contact", "User" CASCADE',
  );
  const { encryptSecret } = await import("../src/lib/auth/mfa-crypto");
  const { base32Decode } = await import("../src/features/auth/totp");
  for (const [user, role, name] of [
    [E2E_ADMIN, "ADMIN", "Admin E2E"],
    [E2E_VIEWER, "VIEWER", "Leitor E2E"],
    [E2E_OPERATOR, "OPERATOR", "Operador E2E"],
  ] as const) {
    await prisma.user.create({
      data: {
        email: user.email,
        name,
        role,
        passwordHash: await bcrypt.hash(user.password, 10),
        ...(role === "ADMIN"
          ? { totpSecretEnc: encryptSecret(base32Decode(E2E_ADMIN_TOTP_SECRET)), totpEnabledAt: new Date() }
          : {}),
      },
    });
  }
  await prisma.$disconnect();
}
