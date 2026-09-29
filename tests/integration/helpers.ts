import { prisma } from "@/lib/db/prisma";
import type { Actor } from "@/server/services/contacts";

export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "CampaignRecipient", "Campaign", "ContactListMember", "ContactList", "ConsentEvent", "SuppressionEntry", "SmsDeliveryEvent", "SmsMessage", "SmsTemplate", "AuditLog", "LoginAttempt", "Contact", "User" CASCADE',
  );
}

export async function createActors(): Promise<Record<"admin" | "operator" | "viewer", Actor>> {
  const make = async (role: "ADMIN" | "OPERATOR" | "VIEWER") => {
    const user = await prisma.user.create({
      data: { name: role, email: `${role.toLowerCase()}@test.local`, passwordHash: "x", role },
    });
    return { id: user.id, role };
  };
  return { admin: await make("ADMIN"), operator: await make("OPERATOR"), viewer: await make("VIEWER") };
}
