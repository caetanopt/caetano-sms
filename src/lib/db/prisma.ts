import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

function getClient() {
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}

// Lazy: o cliente só é criado no primeiro acesso, para que importar este módulo
// (por exemplo durante `next build`) não exija DATABASE_URL.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getClient();
    const value = Reflect.get(client, property, client);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
