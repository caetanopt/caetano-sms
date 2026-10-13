import { ConsentStatus } from "@/generated/prisma/client";
import {
  IMPORT_LIMITS,
  validateImport,
  validateMapping,
  type ColumnMapping,
  type ExistingContact,
  type ImportRow,
  type ImportSummary,
} from "@/features/contacts/import";
import { can } from "@/lib/auth/permissions";
import { CsvParseError, parseCsv } from "@/lib/csv/parse";
import { prisma } from "@/lib/db/prisma";
import type { Actor, ServiceResult } from "./contacts";

export type ImportRequest = {
  csvText: string;
  mapping: ColumnMapping;
  /** O operador confirma que os opt-in do ficheiro estão documentados. */
  importOptIn: boolean;
  listId: string | null;
};

export type ImportPreview = {
  summary: ImportSummary;
  /** Linhas com erros ou avisos, para mostrar no relatório (limitado). */
  issues: ImportRow[];
  /** Amostra de números normalizados a criar. */
  sample: ImportRow[];
};

export type ImportReport = ImportSummary & {
  created: number;
  optOutsApplied: number;
  addedToList: number;
};

const CHUNK = 1000;

function chunks<T>(items: T[], size = CHUNK) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function analyse(request: ImportRequest): Promise<ServiceResult<{ rows: ImportRow[]; summary: ImportSummary }>> {
  if (new TextEncoder().encode(request.csvText).length > IMPORT_LIMITS.maxBytes) {
    return { ok: false, message: `O ficheiro excede ${IMPORT_LIMITS.maxBytes / 1_000_000} MB.` };
  }

  let table;
  try {
    table = parseCsv(request.csvText);
  } catch (error) {
    if (error instanceof CsvParseError) return { ok: false, message: error.message };
    throw error;
  }
  if (table.rows.length > IMPORT_LIMITS.maxRows) {
    return { ok: false, message: `O ficheiro tem mais de ${IMPORT_LIMITS.maxRows} linhas.` };
  }

  const mappingError = validateMapping(request.mapping, table.headers.length);
  if (mappingError) return { ok: false, message: mappingError };

  // 1.ª passagem só para obter os números normalizados a procurar na base de dados.
  const firstPass = validateImport({
    table,
    mapping: request.mapping,
    importOptIn: request.importOptIn,
    existing: new Map(),
    suppressed: new Set(),
  });
  const phones = [...new Set(firstPass.rows.flatMap((row) => (row.phoneE164 ? [row.phoneE164] : [])))];

  const existing = new Map<string, ExistingContact>();
  const suppressed = new Set<string>();
  for (const batch of chunks(phones)) {
    const [contacts, entries] = await Promise.all([
      prisma.contact.findMany({
        where: { phoneE164: { in: batch } },
        select: { phoneE164: true, consentStatus: true, optedOutAt: true },
      }),
      prisma.suppressionEntry.findMany({ where: { phoneE164: { in: batch } }, select: { phoneE164: true } }),
    ]);
    for (const contact of contacts) {
      existing.set(contact.phoneE164, {
        consentStatus: contact.consentStatus,
        optedOut: contact.optedOutAt !== null || contact.consentStatus === ConsentStatus.OPTED_OUT,
      });
    }
    for (const entry of entries) suppressed.add(entry.phoneE164);
  }

  const { rows, summary } = validateImport({
    table,
    mapping: request.mapping,
    importOptIn: request.importOptIn,
    existing,
    suppressed,
  });
  return { ok: true, value: { rows, summary } };
}

export async function previewImport(actor: Actor, request: ImportRequest): Promise<ServiceResult<ImportPreview>> {
  if (!can(actor.role, "contacts:import")) return { ok: false, message: "O teu perfil não permite importar contactos." };
  const analysed = await analyse(request);
  if (!analysed.ok) return analysed;
  const { rows, summary } = analysed.value;
  return {
    ok: true,
    value: {
      summary,
      issues: rows.filter((row) => row.errors.length > 0 || row.warnings.length > 0).slice(0, 200),
      sample: rows.filter((row) => row.outcome === "create").slice(0, 10),
    },
  };
}

export async function commitImport(actor: Actor, request: ImportRequest): Promise<ServiceResult<ImportReport>> {
  if (!can(actor.role, "contacts:import")) return { ok: false, message: "O teu perfil não permite importar contactos." };
  if (request.listId) {
    const list = await prisma.contactList.findUnique({ where: { id: request.listId }, select: { id: true } });
    if (!list) return { ok: false, message: "Lista não encontrada." };
  }

  const analysed = await analyse(request);
  if (!analysed.ok) return analysed;
  const { rows, summary } = analysed.value;

  const toCreate = rows.filter((row) => row.outcome === "create");
  const toOptOut = rows.filter((row) => row.outcome === "existing_opt_out");
  const forList = rows.filter(
    (row) => row.outcome === "create" || row.outcome === "existing" || row.outcome === "existing_opt_out",
  );
  const now = new Date();

  const report = await prisma.$transaction(
    async (tx) => {
      let created = 0;
      for (const batch of chunks(toCreate)) {
        const result = await tx.contact.createMany({
          data: batch.map((row) => ({
            name: row.name,
            phoneE164: row.phoneE164!,
            email: row.email,
            notes: row.notes,
            consentStatus: row.consentStatus,
            consentSource: row.consentSource,
            consentAt: row.consentStatus === "OPTED_IN" ? now : null,
            optedOutAt: row.consentStatus === "OPTED_OUT" ? now : null,
          })),
          // Proteção contra um pedido concorrente com os mesmos números.
          skipDuplicates: true,
        });
        created += result.count;
      }

      const phoneToId = new Map<string, string>();
      for (const batch of chunks(forList.map((row) => row.phoneE164!))) {
        const found = await tx.contact.findMany({
          where: { phoneE164: { in: batch } },
          select: { id: true, phoneE164: true },
        });
        for (const contact of found) phoneToId.set(contact.phoneE164, contact.id);
      }

      // Histórico de consentimento dos contactos criados com estado explícito.
      const consentEvents = toCreate
        .filter((row) => row.consentStatus !== "UNKNOWN" && phoneToId.has(row.phoneE164!))
        .map((row) => ({
          contactId: phoneToId.get(row.phoneE164!)!,
          status: row.consentStatus,
          source: row.consentSource ?? "csv-import",
          purpose: row.consentPurpose,
          process: "csv-import",
          recordedById: actor.id,
          createdAt: now,
        }));

      let optOutsApplied = 0;
      for (const batch of chunks(toOptOut)) {
        const result = await tx.contact.updateMany({
          where: { phoneE164: { in: batch.map((row) => row.phoneE164!) }, optedOutAt: null },
          data: { consentStatus: ConsentStatus.OPTED_OUT, optedOutAt: now, consentSource: "csv-import" },
        });
        optOutsApplied += result.count;
        for (const row of batch) {
          const contactId = phoneToId.get(row.phoneE164!);
          if (contactId) {
            consentEvents.push({
              contactId,
              status: "OPTED_OUT",
              source: row.consentSource ?? "csv-import",
              purpose: row.consentPurpose,
              process: "csv-import",
              recordedById: actor.id,
              createdAt: now,
            });
          }
        }
      }
      for (const batch of chunks(consentEvents)) await tx.consentEvent.createMany({ data: batch });

      const suppressedPhones = [...toCreate, ...toOptOut]
        .filter((row) => row.consentStatus === "OPTED_OUT")
        .map((row) => ({ phoneE164: row.phoneE164!, source: "csv-import" }));
      for (const batch of chunks(suppressedPhones)) {
        await tx.suppressionEntry.createMany({ data: batch, skipDuplicates: true });
      }

      let addedToList = 0;
      if (request.listId) {
        const listId = request.listId;
        const members = [...phoneToId.values()].map((contactId) => ({ listId, contactId }));
        for (const batch of chunks(members)) {
          const result = await tx.contactListMember.createMany({ data: batch, skipDuplicates: true });
          addedToList += result.count;
        }
      }

      const result: ImportReport = { ...summary, created, optOutsApplied, addedToList };
      await tx.auditLog.create({
        data: {
          userId: actor.id,
          action: "CONTACTS_IMPORTED",
          entityType: "Contact",
          entityId: request.listId,
          // Apenas contagens: sem números nem nomes.
          metadataJson: {
            totalRows: summary.totalRows,
            created,
            existing: summary.existing,
            optOutsApplied,
            invalid: summary.invalid,
            duplicateInFile: summary.duplicateInFile,
            newOptedIn: summary.newOptedIn,
            importOptIn: request.importOptIn,
            listId: request.listId,
            addedToList,
          },
        },
      });
      return result;
    },
    { timeout: 60_000 },
  );

  return { ok: true, value: report };
}
