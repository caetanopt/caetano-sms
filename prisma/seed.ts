import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, UserRole } from "../src/generated/prisma/client";

const databaseUrl = process.env.DATABASE_URL;
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME ?? "Administrador";
const resetMfa = process.env.ADMIN_RESET_MFA === "true";

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!email) throw new Error("ADMIN_EMAIL is required");
if (!password || password.length < 12) {
  throw new Error("ADMIN_PASSWORD must contain at least 12 characters");
}

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });

const passwordHash = await bcrypt.hash(password, 12);

await prisma.user.upsert({
  where: { email: email.toLowerCase() },
  create: {
    email: email.toLowerCase(),
    name,
    passwordHash,
    role: UserRole.ADMIN,
  },
  // Voltar a correr o seed serve de recuperação do administrador: termina as sessões antigas.
  update: {
    name,
    passwordHash,
    role: UserRole.ADMIN,
    isActive: true,
    mustChangePassword: false,
    passwordChangedAt: new Date(),
    sessionVersion: { increment: 1 },
    // Recuperação total (telemóvel perdido, sem outro administrador): só com pedido explícito.
    ...(resetMfa ? { totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null, totpPendingSecretEnc: null, totpPendingAt: null } : {}),
  },
});

if (resetMfa) {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
  await prisma.mfaRecoveryCode.deleteMany({ where: { userId: user.id } });
  await prisma.auditLog.create({ data: { action: "USER_MFA_RESET", entityType: "User", entityId: user.id, metadataJson: { source: "seed" } } });
  console.log("2FA reposto: será pedida nova configuração no próximo login.");
}

console.log(`Admin ready: ${email.toLowerCase()}`);
await prisma.$disconnect();
