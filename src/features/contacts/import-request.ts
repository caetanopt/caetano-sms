import { z } from "zod";
import { IMPORT_FIELDS, type ColumnMapping } from "./import";

// partialRecord: em Zod 4, z.record com chaves enum exige todas as chaves.
const mappingSchema = z.partialRecord(z.enum(IMPORT_FIELDS), z.number().int().min(0).max(200));

export type ParsedImportRequest = {
  csvText: string;
  mapping: ColumnMapping;
  importOptIn: boolean;
  listId: string | null;
};

/** Lê e valida os campos do formulário de importação (nunca confia no browser). */
export function parseImportFormData(formData: FormData): ParsedImportRequest | null {
  const csvText = formData.get("csvText");
  const rawMapping = formData.get("mapping");
  const listId = formData.get("listId");
  if (typeof csvText !== "string" || typeof rawMapping !== "string") return null;

  let json: unknown;
  try {
    json = JSON.parse(rawMapping);
  } catch {
    return null;
  }
  const parsed = mappingSchema.safeParse(json);
  if (!parsed.success) return null;

  return {
    csvText,
    mapping: parsed.data,
    importOptIn: formData.get("importOptIn") === "on",
    listId: typeof listId === "string" && listId !== "" ? listId : null,
  };
}
