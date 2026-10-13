import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { prismaManualSendStore } from "@/server/repositories/prisma-manual-send-store";
import { changeContactConsent, createContact, deleteContact, type Actor } from "@/server/services/contacts";
import { addContactToList, createList, getListEligibility } from "@/server/services/lists";
import { createActors, resetDatabase } from "./helpers";

let actors: Record<"admin" | "operator" | "viewer", Actor>;

beforeEach(async () => {
  await resetDatabase();
  actors = await createActors();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const optIn = { source: "loja", purpose: "marketing", textVersion: "v1" };

describe("contacts service", () => {
  it("creates a contact in E.164 with a consent record and audit", async () => {
    const result = await createContact(actors.operator, {
      name: "Maria",
      phone: "912 345 678",
      consentStatus: "OPTED_IN",
      consent: optIn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const contact = await prisma.contact.findUniqueOrThrow({
      where: { id: result.value.id },
      include: { consentEvents: true },
    });
    expect(contact).toMatchObject({ phoneE164: "+351912345678", consentStatus: "OPTED_IN", consentSource: "loja" });
    expect(contact.consentAt).toBeInstanceOf(Date);
    expect(contact.consentEvents).toHaveLength(1);
    expect(contact.consentEvents[0]).toMatchObject({
      status: "OPTED_IN",
      purpose: "marketing",
      textVersion: "v1",
      process: "manual",
      recordedById: actors.operator.id,
    });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CONTACT_CREATED" } });
    expect(JSON.stringify(audit.metadataJson)).not.toContain("912345678");
  });

  it("rejects duplicates and opt-in without purpose", async () => {
    await createContact(actors.operator, { name: "A", phone: "912345678", consentStatus: "UNKNOWN", consent: {} });
    expect(
      await createContact(actors.operator, { name: "B", phone: "+351912345678", consentStatus: "UNKNOWN", consent: {} }),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/Já existe/) });
    expect(
      await createContact(actors.operator, {
        name: "C",
        phone: "913456789",
        consentStatus: "OPTED_IN",
        consent: { source: "loja" },
      }),
    ).toMatchObject({ ok: false });
  });

  it("denies VIEWER writes", async () => {
    expect(
      await createContact(actors.viewer, { name: "A", phone: "912345678", consentStatus: "UNKNOWN", consent: {} }),
    ).toMatchObject({ ok: false });
    expect(await prisma.contact.count()).toBe(0);
  });

  it("opt-out adds to suppression list, which survives deletion and blocks sends and re-creation", async () => {
    const created = await createContact(actors.operator, {
      name: "Maria",
      phone: "912345678",
      consentStatus: "OPTED_IN",
      consent: optIn,
    });
    if (!created.ok) throw new Error("setup");
    const id = created.value.id;

    expect(await changeContactConsent(actors.operator, id, "OPTED_OUT", { source: "STOP" })).toMatchObject({ ok: true });
    expect(await prismaManualSendStore.isSuppressed("+351912345678")).toBe(true);

    // OPERATOR não pode voltar a opt-in; só ADMIN.
    expect(await changeContactConsent(actors.operator, id, "OPTED_IN", optIn)).toMatchObject({ ok: false });

    // Só ADMIN elimina; a suppression list mantém-se.
    expect(await deleteContact(actors.operator, id)).toMatchObject({ ok: false });
    expect(await deleteContact(actors.admin, id)).toMatchObject({ ok: true });
    expect(await prisma.contact.count()).toBe(0);
    expect(await prismaManualSendStore.isSuppressed("+351912345678")).toBe(true);

    // Recriar o mesmo número com opt-in resulta em opt-out.
    const recreated = await createContact(actors.operator, {
      name: "Maria",
      phone: "912345678",
      consentStatus: "OPTED_IN",
      consent: optIn,
    });
    expect(recreated).toMatchObject({ ok: true, warning: expect.stringMatching(/suppression/) });
    if (recreated.ok) {
      const contact = await prisma.contact.findUniqueOrThrow({ where: { id: recreated.value.id } });
      expect(contact.consentStatus).toBe("OPTED_OUT");
    }
  });

  it("ADMIN re-opt-in removes the number from the suppression list and records history", async () => {
    const created = await createContact(actors.operator, { name: "A", phone: "912345678", consentStatus: "OPTED_OUT", consent: {} });
    if (!created.ok) throw new Error("setup");
    expect(await changeContactConsent(actors.admin, created.value.id, "OPTED_IN", optIn)).toMatchObject({ ok: true });

    const contact = await prisma.contact.findUniqueOrThrow({
      where: { id: created.value.id },
      include: { consentEvents: { orderBy: { createdAt: "asc" } } },
    });
    expect(contact).toMatchObject({ consentStatus: "OPTED_IN", optedOutAt: null });
    expect(contact.consentEvents.map((event) => event.status)).toEqual(["OPTED_OUT", "OPTED_IN"]);
    expect(await prismaManualSendStore.isSuppressed("+351912345678")).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "CONTACT_REOPTED_IN" } })).toBe(1);
  });
});

describe("lists service", () => {
  it("adds members idempotently and computes eligibility", async () => {
    const list = await createList(actors.operator, { name: "Clientes" });
    if (!list.ok) throw new Error("setup");
    const ids: string[] = [];
    for (const [phone, consentStatus] of [
      ["912345678", "OPTED_IN"],
      ["913456789", "UNKNOWN"],
      ["914567890", "OPTED_OUT"],
    ] as const) {
      const created = await createContact(actors.operator, { name: phone, phone, consentStatus, consent: optIn });
      if (!created.ok) throw new Error("setup");
      ids.push(created.value.id);
      expect(await addContactToList(actors.operator, list.value.id, created.value.id)).toMatchObject({ ok: true });
    }
    expect(await addContactToList(actors.operator, list.value.id, ids[0])).toMatchObject({
      ok: true,
      warning: expect.stringMatching(/já pertencia/),
    });
    expect(await getListEligibility(list.value.id)).toEqual({ total: 3, optedIn: 1, optedOut: 1, withoutConsent: 1 });
    expect(await createList(actors.operator, { name: "Clientes" })).toMatchObject({ ok: false });
    expect(await createList(actors.viewer, { name: "Outra" })).toMatchObject({ ok: false });
  });
});
