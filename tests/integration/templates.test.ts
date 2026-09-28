import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { Actor } from "@/server/services/contacts";
import { createTemplate, deleteTemplate, updateTemplate } from "@/server/services/templates";
import { createActors, resetDatabase } from "./helpers";

let actors: Record<"admin" | "operator" | "viewer", Actor>;

beforeEach(async () => {
  await resetDatabase();
  actors = await createActors();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const valid = {
  name: "Lembrete",
  body: "Olá {{firstName}}, a sua marcação é no dia {{date}} às {{time}}.",
  messageType: "TRANSACTIONAL" as const,
};

describe("templates service", () => {
  it("creates, updates and audits templates", async () => {
    const created = await createTemplate(actors.operator, valid);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await updateTemplate(actors.operator, created.value.id, { ...valid, messageType: "PROMOTIONAL" })).toMatchObject({
      ok: true,
    });
    const template = await prisma.smsTemplate.findUniqueOrThrow({ where: { id: created.value.id } });
    expect(template).toMatchObject({ messageType: "PROMOTIONAL", createdById: actors.operator.id });

    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((log) => log.action);
    expect(actions).toEqual(["TEMPLATE_CREATED", "TEMPLATE_UPDATED"]);
    const update = await prisma.auditLog.findFirstOrThrow({ where: { action: "TEMPLATE_UPDATED" } });
    expect(update.metadataJson).toMatchObject({ messageTypeChanged: true });
  });

  it("rejects invalid templates, duplicate names and VIEWER", async () => {
    expect(await createTemplate(actors.operator, { ...valid, body: "Olá {{nome}}" })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/desconhecida/),
    });
    await createTemplate(actors.operator, valid);
    expect(await createTemplate(actors.operator, valid)).toMatchObject({ ok: false, message: expect.stringMatching(/Já existe/) });
    expect(await createTemplate(actors.viewer, { ...valid, name: "Outro" })).toMatchObject({ ok: false });
    expect(await prisma.smsTemplate.count()).toBe(1);
  });

  it("deleting keeps sent messages with their text", async () => {
    const created = await createTemplate(actors.operator, valid);
    if (!created.ok) throw new Error("setup");
    const message = await prisma.smsMessage.create({
      data: {
        idempotencyKey: crypto.randomUUID(),
        destinationPhoneE164: "+351912345678",
        messageType: "TRANSACTIONAL",
        body: "Olá Maria, a sua marcação é no dia 1 às 2.",
        provider: "fake",
        dryRun: true,
        templateId: created.value.id,
        createdById: actors.operator.id,
      },
    });

    expect(await deleteTemplate(actors.viewer, created.value.id)).toMatchObject({ ok: false });
    expect(await deleteTemplate(actors.operator, created.value.id)).toMatchObject({ ok: true });
    const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(after).toMatchObject({ templateId: null, body: "Olá Maria, a sua marcação é no dia 1 às 2." });
  });
});
