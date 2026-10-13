import type { ImportRow, ImportSummary } from "./import";

export type ImportReportView = ImportSummary & {
  created: number;
  optOutsApplied: number;
  addedToList: number;
};

export type ImportFormState = {
  step: "edit" | "preview" | "done";
  error?: string;
  preview?: { summary: ImportSummary; issues: ImportRow[]; sample: ImportRow[] };
  report?: ImportReportView;
};

export const initialImportState: ImportFormState = { step: "edit" };
