import { describe, expect, it } from "vitest";
import { suggestMapping, validateImport, validateMapping, type ExistingContact } from "../src/features/contacts/import";
import { parseCsv } from "../src/lib/csv/parse";

const HEADER = "name,phone,consent_status,consent_source";

function run(
  body: string,
  options: { importOptIn?: boolean; existing?: Record<string, ExistingContact>; suppressed?: string[] } = {},
) {
  const table = parseCsv(`${HEADER}\n${body}`);
  return validateImport({
    table,
    mapping: suggestMapping(table.headers),
    importOptIn: options.importOptIn ?? true,
    existing: new Map(Object.entries(options.existing ?? {})),
    suppressed: new Set(options.suppressed ?? []),
  });
}

describe("suggestMapping", () => {
  it("maps English and Portuguese headers", () => {
    expect(suggestMapping(["name", "phone", "consent_status", "consent_source"])).toEqual({
      name: 0,
      phone: 1,
      consentStatus: 2,
      consentSource: 3,
    });
    expect(suggestMapping(["Nome", "Telemóvel", "Email", "Notas"])).toEqual({ name: 0, phone: 1, email: 2, notes: 3 });
  });
});

describe("validateMapping", () => {
  it("requires name and phone and distinct columns", () => {
    expect(validateMapping({ phone: 1 }, 2)).toMatch(/Nome/);
    expect(validateMapping({ name: 0 }, 2)).toMatch(/Telefone/);
    expect(validateMapping({ name: 0, phone: 0 }, 2)).toMatch(/mesma coluna/);
    expect(validateMapping({ name: 0, phone: 5 }, 2)).toMatch(/inválido/);
    expect(validateMapping({ name: 0, phone: 1 }, 2)).toBeNull();
  });
});

describe("validateImport", () => {
  it("imports the recommended format and normalizes numbers to E.164", () => {
    const { rows, summary } = run("Maria,912 345 678,OPTED_IN,website\nJoao,+351913456789,UNKNOWN,legacy-import");
    expect(rows[0]).toMatchObject({
      outcome: "create",
      phoneE164: "+351912345678",
      consentStatus: "OPTED_IN",
      consentSource: "website",
    });
    expect(rows[1]).toMatchObject({ outcome: "create", consentStatus: "UNKNOWN", consentSource: null });
    expect(summary).toMatchObject({ create: 2, newOptedIn: 1, newUnknown: 1, invalid: 0 });
  });

  it("never infers consent from the mere presence of a number", () => {
    const table = parseCsv("name,phone\nMaria,912345678");
    const { rows } = validateImport({
      table,
      mapping: suggestMapping(table.headers),
      importOptIn: true,
      existing: new Map(),
      suppressed: new Set(),
    });
    expect(rows[0].consentStatus).toBe("UNKNOWN");
  });

  it("ignores opt-in from the file unless the operator confirms it", () => {
    const { rows } = run("Maria,912345678,OPTED_IN,website", { importOptIn: false });
    expect(rows[0].consentStatus).toBe("UNKNOWN");
    expect(rows[0].warnings.join()).toMatch(/confirmação/);
  });

  it("requires a consent source for opt-in", () => {
    const { rows } = run("Maria,912345678,OPTED_IN,");
    expect(rows[0].consentStatus).toBe("UNKNOWN");
    expect(rows[0].warnings.join()).toMatch(/origem/);
  });

  it("always honours opt-out, even without confirmation", () => {
    const { rows } = run("Maria,912345678,OPTED_OUT,", { importOptIn: false });
    expect(rows[0]).toMatchObject({ outcome: "create", consentStatus: "OPTED_OUT", consentSource: "csv-import" });
  });

  it("keeps suppressed numbers opted out", () => {
    const { rows } = run("Maria,912345678,OPTED_IN,website", { suppressed: ["+351912345678"] });
    expect(rows[0].consentStatus).toBe("OPTED_OUT");
    expect(rows[0].warnings.join()).toMatch(/suppression/);
  });

  it("rejects invalid rows with reasons", () => {
    const { rows, summary } = run(",912345678,,\nAna,123,,\nRui,,,");
    expect(rows.map((row) => row.outcome)).toEqual(["invalid", "invalid", "invalid"]);
    expect(rows[0].errors).toContain("Nome em falta.");
    expect(rows[1].errors).toContain("Número de telefone inválido.");
    expect(rows[2].errors).toContain("Telefone em falta.");
    expect(summary.invalid).toBe(3);
  });

  it("detects duplicates within the file after normalization", () => {
    const { rows, summary } = run("Maria,912345678,,\nMaria B,+351 912 345 678,,");
    expect(rows[1]).toMatchObject({ outcome: "duplicate_in_file" });
    expect(rows[1].warnings.join()).toMatch(/linha 2/);
    expect(summary).toMatchObject({ create: 1, duplicateInFile: 1 });
  });

  it("never upgrades consent of existing contacts, but applies opt-out", () => {
    const existing = {
      "+351912345678": { consentStatus: "UNKNOWN" as const, optedOut: false },
      "+351913456789": { consentStatus: "OPTED_IN" as const, optedOut: false },
      "+351914567890": { consentStatus: "OPTED_OUT" as const, optedOut: true },
    };
    const { rows, summary } = run(
      "Maria,912345678,OPTED_IN,website\nJoao,913456789,OPTED_OUT,\nAna,914567890,OPTED_IN,website",
      { existing },
    );
    expect(rows.map((row) => row.outcome)).toEqual(["existing", "existing_opt_out", "existing"]);
    expect(rows[0].warnings.join()).toMatch(/não é alterado/);
    expect(summary).toMatchObject({ create: 0, existing: 2, existingOptOut: 1 });
  });

  it("treats unknown consent values as UNKNOWN with a warning", () => {
    const { rows } = run("Maria,912345678,talvez,website");
    expect(rows[0].consentStatus).toBe("UNKNOWN");
    expect(rows[0].warnings.join()).toMatch(/desconhecido/);
  });

  it("drops invalid emails with a warning", () => {
    const table = parseCsv("name,phone,email\nMaria,912345678,nao-e-email\nAna,913456789,Ana@Example.PT");
    const { rows } = validateImport({
      table,
      mapping: suggestMapping(table.headers),
      importOptIn: false,
      existing: new Map(),
      suppressed: new Set(),
    });
    expect(rows[0]).toMatchObject({ outcome: "create", email: null });
    expect(rows[1].email).toBe("ana@example.pt");
  });
});
