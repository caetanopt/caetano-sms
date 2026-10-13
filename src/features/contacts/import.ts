import { z } from "zod";
import type { CsvTable } from "@/lib/csv/parse";
import { normalizePhoneNumber } from "@/lib/phone/normalize";
import type { ConsentStatusValue } from "./consent";

export const IMPORT_LIMITS = { maxBytes: 2_000_000, maxRows: 5_000 } as const;

export const IMPORT_FIELDS = [
  "name",
  "phone",
  "email",
  "consentStatus",
  "consentSource",
  "consentPurpose",
  "notes",
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  name: "Nome *",
  phone: "Telefone *",
  email: "Email",
  consentStatus: "Estado de consentimento",
  consentSource: "Origem do consentimento",
  consentPurpose: "Finalidade do consentimento",
  notes: "Notas",
};

/** Índice da coluna CSV para cada campo (ausente = não importar). */
export type ColumnMapping = Partial<Record<ImportField, number>>;

const ALIASES: Record<ImportField, string[]> = {
  name: ["name", "nome", "nome completo", "full name", "cliente"],
  phone: ["phone", "telefone", "telemovel", "telemóvel", "mobile", "numero", "número", "phone_number", "tlm"],
  email: ["email", "e-mail", "mail"],
  consentStatus: ["consent_status", "consentstatus", "consentimento", "consent", "estado_consentimento"],
  consentSource: ["consent_source", "consentsource", "origem", "origem_consentimento", "source"],
  consentPurpose: ["consent_purpose", "finalidade", "purpose"],
  notes: ["notes", "notas", "observacoes", "observações", "obs"],
};

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function suggestMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const normalized = headers.map(normalizeHeader);
  for (const field of IMPORT_FIELDS) {
    const index = normalized.findIndex((header) => ALIASES[field].includes(header));
    if (index >= 0 && !Object.values(mapping).includes(index)) mapping[field] = index;
  }
  return mapping;
}

export type ExistingContact = { consentStatus: ConsentStatusValue; optedOut: boolean };

export type ImportOutcome =
  | "create"
  /** Já existe; o ficheiro indica opt-out e o contacto ainda não estava em opt-out. */
  | "existing_opt_out"
  /** Já existe; nada é alterado (a importação nunca melhora o consentimento). */
  | "existing"
  | "duplicate_in_file"
  | "invalid";

export type ImportRow = {
  line: number;
  outcome: ImportOutcome;
  name: string;
  phoneE164: string | null;
  email: string | null;
  notes: string | null;
  consentStatus: ConsentStatusValue;
  consentSource: string | null;
  consentPurpose: string | null;
  errors: string[];
  warnings: string[];
};

export type ImportSummary = {
  totalRows: number;
  create: number;
  existing: number;
  existingOptOut: number;
  duplicateInFile: number;
  invalid: number;
  newOptedIn: number;
  newOptedOut: number;
  newUnknown: number;
  withWarnings: number;
};

export type ImportValidation = { rows: ImportRow[]; summary: ImportSummary };

function parseConsentValue(raw: string): ConsentStatusValue | null {
  const value = raw.trim().toUpperCase().replace(/[-\s]/g, "_");
  if (value === "") return "UNKNOWN";
  if (value === "OPTED_IN" || value === "OPT_IN" || value === "OPTIN") return "OPTED_IN";
  if (value === "OPTED_OUT" || value === "OPT_OUT" || value === "OPTOUT") return "OPTED_OUT";
  if (value === "UNKNOWN" || value === "DESCONHECIDO") return "UNKNOWN";
  return null;
}

const emailSchema = z.email();

function cell(cells: string[], index: number | undefined) {
  if (index === undefined) return "";
  return (cells[index] ?? "").trim();
}

function limit(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

export function validateMapping(mapping: ColumnMapping, columnCount: number): string | null {
  if (mapping.name === undefined) return "Associa uma coluna ao campo Nome.";
  if (mapping.phone === undefined) return "Associa uma coluna ao campo Telefone.";
  const used = Object.values(mapping);
  if (used.some((index) => index < 0 || index >= columnCount)) return "Mapeamento de colunas inválido.";
  if (new Set(used).size !== used.length) return "A mesma coluna não pode ser usada em dois campos.";
  return null;
}

/**
 * Valida as linhas de um CSV já parseado. Função pura: a lista de contactos
 * existentes e a suppression list são fornecidas pelo chamador.
 *
 * Regras de consentimento (CLAUDE.md §12, §23):
 * - a presença de um número no ficheiro nunca implica consentimento;
 * - OPTED_IN só é aceite se `importOptIn` estiver ativo e a linha tiver origem;
 * - OPTED_OUT do ficheiro é sempre respeitado (restringe, nunca alarga);
 * - números na suppression list são criados em OPTED_OUT;
 * - contactos existentes nunca sobem de consentimento; só podem passar a opt-out.
 */
export function validateImport(input: {
  table: CsvTable;
  mapping: ColumnMapping;
  importOptIn: boolean;
  existing: ReadonlyMap<string, ExistingContact>;
  suppressed: ReadonlySet<string>;
}): ImportValidation {
  const { table, mapping, importOptIn, existing, suppressed } = input;
  const seen = new Map<string, number>();
  const rows: ImportRow[] = [];

  for (const { line, cells } of table.rows) {
    const errors: string[] = [];
    const warnings: string[] = [];

    const name = limit(cell(cells, mapping.name), 120);
    const rawPhone = cell(cells, mapping.phone);
    const rawEmail = cell(cells, mapping.email);
    const notes = limit(cell(cells, mapping.notes), 1000) || null;
    const source = limit(cell(cells, mapping.consentSource), 120) || null;
    const purpose = limit(cell(cells, mapping.consentPurpose), 120) || null;

    if (!name) errors.push("Nome em falta.");

    let phoneE164: string | null = null;
    if (!rawPhone) {
      errors.push("Telefone em falta.");
    } else {
      try {
        phoneE164 = normalizePhoneNumber(rawPhone);
      } catch {
        errors.push("Número de telefone inválido.");
      }
    }

    let email: string | null = null;
    if (rawEmail) {
      if (emailSchema.safeParse(rawEmail).success) email = rawEmail.toLowerCase();
      else warnings.push("Email inválido: não será importado.");
    }

    let consentStatus: ConsentStatusValue = "UNKNOWN";
    const parsedConsent = parseConsentValue(cell(cells, mapping.consentStatus));
    if (parsedConsent === null) {
      warnings.push("Estado de consentimento desconhecido: importado como UNKNOWN.");
    } else if (parsedConsent === "OPTED_OUT") {
      consentStatus = "OPTED_OUT";
    } else if (parsedConsent === "OPTED_IN") {
      if (!importOptIn) {
        warnings.push("Opt-in do ficheiro não importado (confirmação não assinalada): importado como UNKNOWN.");
      } else if (!source) {
        warnings.push("Opt-in sem origem do consentimento: importado como UNKNOWN.");
      } else {
        consentStatus = "OPTED_IN";
      }
    }

    if (phoneE164 && suppressed.has(phoneE164) && consentStatus !== "OPTED_OUT") {
      consentStatus = "OPTED_OUT";
      warnings.push("Número na suppression list: mantém-se em opt-out.");
    }

    let outcome: ImportOutcome;
    if (errors.length > 0 || !phoneE164) {
      outcome = "invalid";
    } else if (seen.has(phoneE164)) {
      outcome = "duplicate_in_file";
      warnings.push(`Número repetido (primeira ocorrência na linha ${seen.get(phoneE164)}).`);
    } else {
      seen.set(phoneE164, line);
      const current = existing.get(phoneE164);
      if (!current) {
        outcome = "create";
      } else if (consentStatus === "OPTED_OUT" && !current.optedOut) {
        outcome = "existing_opt_out";
      } else {
        outcome = "existing";
        if (consentStatus === "OPTED_IN" && current.consentStatus !== "OPTED_IN") {
          warnings.push("Contacto já existe: o consentimento não é alterado pela importação.");
        }
      }
    }

    rows.push({
      line,
      outcome,
      name,
      phoneE164,
      email,
      notes,
      consentStatus,
      consentSource: consentStatus === "UNKNOWN" ? null : (source ?? "csv-import"),
      consentPurpose: consentStatus === "UNKNOWN" ? null : purpose,
      errors,
      warnings,
    });
  }

  const created = rows.filter((row) => row.outcome === "create");
  const summary: ImportSummary = {
    totalRows: rows.length,
    create: created.length,
    existing: rows.filter((row) => row.outcome === "existing").length,
    existingOptOut: rows.filter((row) => row.outcome === "existing_opt_out").length,
    duplicateInFile: rows.filter((row) => row.outcome === "duplicate_in_file").length,
    invalid: rows.filter((row) => row.outcome === "invalid").length,
    newOptedIn: created.filter((row) => row.consentStatus === "OPTED_IN").length,
    newOptedOut: created.filter((row) => row.consentStatus === "OPTED_OUT").length,
    newUnknown: created.filter((row) => row.consentStatus === "UNKNOWN").length,
    withWarnings: rows.filter((row) => row.warnings.length > 0).length,
  };

  return { rows, summary };
}
