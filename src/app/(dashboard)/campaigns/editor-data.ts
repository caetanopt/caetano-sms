import { prisma } from "@/lib/db/prisma";

export async function loadEditorData() {
  const [lists, templates] = await Promise.all([
    prisma.contactList.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, _count: { select: { members: true } } },
    }),
    prisma.smsTemplate.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, body: true, messageType: true } }),
  ]);
  return {
    lists: lists.map((list) => ({ id: list.id, name: list.name, members: list._count.members })),
    templates,
  };
}
