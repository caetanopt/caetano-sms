/**
 * Parser CSV mínimo (RFC 4180): aspas, aspas escapadas (""), quebras de linha
 * dentro de aspas, CRLF/LF e BOM. Deteta `,` ou `;` (Excel PT usa `;`).
 * Função pura: usada no browser (preview) e no servidor (validação/importação).
 */

export type CsvTable = {
  delimiter: "," | ";" | "\t";
  headers: string[];
  /** Linhas de dados (sem cabeçalho) com o número de linha original no ficheiro. */
  rows: Array<{ line: number; cells: string[] }>;
};

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

function detectDelimiter(text: string): CsvTable["delimiter"] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const char of firstLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char as keyof typeof counts] += 1;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","]) return "\t";
  return ",";
}

export function parseCsv(input: string): CsvTable {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);

  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(field);
    records.push({ line: recordLine, cells });
    cells = [];
    field = "";
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === delimiter) {
      cells.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += char;
    }
  }

  if (inQuotes) throw new CsvParseError(`Aspas por fechar a partir da linha ${recordLine}.`);
  if (field !== "" || cells.length > 0) endRecord();

  const nonEmpty = records.filter((record) => record.cells.some((cell) => cell.trim() !== ""));
  if (nonEmpty.length === 0) throw new CsvParseError("O ficheiro está vazio.");

  const [header, ...rows] = nonEmpty;
  const headers = header.cells.map((cell) => cell.trim());
  if (headers.every((cell) => cell === "")) throw new CsvParseError("O cabeçalho está vazio.");

  return { delimiter, headers, rows };
}
