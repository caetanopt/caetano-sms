import { describe, expect, it } from "vitest";
import { CsvParseError, parseCsv } from "../src/lib/csv/parse";

describe("parseCsv", () => {
  it("parses a simple comma-separated file", () => {
    const table = parseCsv("name,phone\nMaria,+351912345678\nJoao,+351913456789\n");
    expect(table.delimiter).toBe(",");
    expect(table.headers).toEqual(["name", "phone"]);
    expect(table.rows).toEqual([
      { line: 2, cells: ["Maria", "+351912345678"] },
      { line: 3, cells: ["Joao", "+351913456789"] },
    ]);
  });

  it("detects semicolons (Excel PT) and strips BOM", () => {
    const table = parseCsv("﻿nome;telefone\r\nAna;912 345 678\r\n");
    expect(table.delimiter).toBe(";");
    expect(table.headers).toEqual(["nome", "telefone"]);
    expect(table.rows[0].cells).toEqual(["Ana", "912 345 678"]);
  });

  it("handles quoted fields with delimiters, escaped quotes and newlines", () => {
    const table = parseCsv('name,notes\n"Silva, Maria","Disse ""olá""\nsegunda linha"\nJoão,x');
    expect(table.rows[0].cells).toEqual(["Silva, Maria", 'Disse "olá"\nsegunda linha']);
    expect(table.rows[1]).toEqual({ line: 4, cells: ["João", "x"] });
  });

  it("skips blank lines but keeps original line numbers", () => {
    const table = parseCsv("name,phone\n\nMaria,1\n  \nJoao,2");
    expect(table.rows.map((row) => row.line)).toEqual([3, 5]);
  });

  it("keeps Portuguese characters intact", () => {
    expect(parseCsv("nome\nJoão Conceição").rows[0].cells[0]).toBe("João Conceição");
  });

  it("rejects unclosed quotes and empty files", () => {
    expect(() => parseCsv('name\n"aberto')).toThrow(CsvParseError);
    expect(() => parseCsv("\n\n")).toThrow(CsvParseError);
  });
});
