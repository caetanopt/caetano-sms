import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { suggestMapping } from "@/features/contacts/import";
import { parseCsv } from "@/lib/csv/parse";
import { prisma } from "@/lib/db/prisma";
import { commitImport, previewImport } from "@/server/services/contact-import";
import { createContact, type Actor } from "@/server/services/contacts";
import { createList } from "@/server/services/lists";
import { createActors, resetDatabase } from "./helpers";

let actors: Record<"admin" | "operator" | "viewer", Actor>;

beforeEach(async () => {
  await resetDatabase();
  actors = await createActors();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const CSV = [
  "name;phone;consent_status;consent_source",
  "Maria;912 345 678;OPTED_IN;website",
  "Joao;+351913456789;UNKNOWN;legacy-import",
  "Rui;914567890;OPTED_OUT;",
  "Ana;123;OPTED_IN;website",
  "Maria dup;+351912345678;;",
  "Existente;915678901;OPTED_OUT;",
].join("\n");

function request(overrides: Partial<Parameters<typeof commitImport>[1]> = {}) {
  return {
    csvText: CSV,
    mapping: suggestMapping(parseCsv(CSV).headers),
    importOptIn: true,
    listId: null,
    ...overrides,
  };
}

describe("contact import", () => {
  it("previews without writing anything", async () => {
    const preview = await previewImport(actors.operator, request());
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.value.summary).toMatchObject({ create: 4, invalid: 1, duplicateInFile: 1 });
    expect(await prisma.contact.count()).toBe(0);
  });

  it("imports, applies consent rules, suppression, list membership and is re-runnable", async () => {
    await createContact(actors.operator, { name: "Existente", phone: "915678901", consentStatus: "UNKNOWN", consent: {} });
    const list = await createList(actors.operator, { name: "Importados" });
    if (!list.ok) throw new Error("setup");

    const result = await commitImport(actors.operator, request({ listId: list.value.id }));
    expect(result).toMatchObject({
      ok: true,
      value: { created: 3, existingOptOut: 1, optOutsApplied: 1, invalid: 1, duplicateInFile: 1, addedToList: 4 },
    });

    const contacts = await prisma.contact.findMany({ orderBy: { phoneE164: "asc" } });
    expect(contacts.map((contact) => [contact.phoneE164, contact.consentStatus])).toEqual([
      ["+351912345678", "OPTED_IN"],
      ["+351913456789", "UNKNOWN"],
      ["+351914567890", "OPTED_OUT"],
      ["+351915678901", "OPTED_OUT"],
    ]);
    const suppressed = await prisma.suppressionEntry.findMany({ orderBy: { phoneE164: "asc" } });
    expect(suppressed.map((entry) => entry.phoneE164)).toEqual(["+351914567890", "+351915678901"]);
    expect(await prisma.consentEvent.count({ where: { process: "csv-import" } })).toBe(3);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CONTACTS_IMPORTED" } });
    expect(JSON.stringify(audit.metadataJson)).not.toMatch(/9\d{8}/);

    // Voltar a importar o mesmo ficheiro não cria duplicados.
    const again = await commitImport(actors.operator, request({ listId: list.value.id }));
    expect(again).toMatchObject({ ok: true, value: { created: 0, optOutsApplied: 0, addedToList: 0 } });
    expect(await prisma.contact.count()).toBe(4);
  });

  it("imports opt-in as UNKNOWN when the operator does not confirm", async () => {
    await commitImport(actors.operator, request({ importOptIn: false }));
    const maria = await prisma.contact.findUniqueOrThrow({ where: { phoneE164: "+351912345678" } });
    expect(maria.consentStatus).toBe("UNKNOWN");
  });

  it("denies VIEWER", async () => {
    expect(await commitImport(actors.viewer, request())).toMatchObject({ ok: false });
    expect(await prisma.contact.count()).toBe(0);
  });

  it("rejects oversized files and bad mappings", async () => {
    const big = "name,phone\n" + "Maria,912345678\n".repeat(150_000);
    expect(await previewImport(actors.operator, request({ csvText: big }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/MB/),
    });
    expect(await previewImport(actors.operator, request({ mapping: { name: 0 } }))).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Telefone/),
    });
  });
});
