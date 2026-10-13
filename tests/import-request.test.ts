import { describe, expect, it } from "vitest";
import { parseImportFormData } from "../src/features/contacts/import-request";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("parseImportFormData", () => {
  it("accepts a partial mapping", () => {
    expect(
      parseImportFormData(form({ csvText: "a,b", mapping: JSON.stringify({ name: 0, phone: 1 }), importOptIn: "on", listId: "l1" })),
    ).toEqual({ csvText: "a,b", mapping: { name: 0, phone: 1 }, importOptIn: true, listId: "l1" });
  });

  it("defaults opt-in import to false and list to null", () => {
    expect(parseImportFormData(form({ csvText: "a", mapping: "{}", listId: "" }))).toMatchObject({
      importOptIn: false,
      listId: null,
    });
  });

  it("rejects unknown fields, bad indexes and invalid JSON", () => {
    expect(parseImportFormData(form({ csvText: "a", mapping: JSON.stringify({ role: 0 }) }))).toBeNull();
    expect(parseImportFormData(form({ csvText: "a", mapping: JSON.stringify({ name: -1 }) }))).toBeNull();
    expect(parseImportFormData(form({ csvText: "a", mapping: "{" }))).toBeNull();
    expect(parseImportFormData(form({ mapping: "{}" }))).toBeNull();
  });
});
