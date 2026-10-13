import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;
const ALLOWED = "src/server/repositories/prisma-manual-send-store.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

// As contagens de quota e de limites por minuto só são coerentes se TODO o INSERT de SmsMessage
// participar no lock de envio (ver o invariante em src/server/services/send-rate.ts). O único
// sítio que insere é o store, que o garante nos dois ramos; um INSERT novo noutro ficheiro tem de
// passar por lá (ou tomar o lock) e atualizar este teste conscientemente.
describe("inserções de SmsMessage", () => {
  it("só acontecem no store que aplica o lock de envio", () => {
    const offenders = [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "scripts"))]
      .filter((file) => /\.smsMessage\.(create|createMany|createManyAndReturn|upsert)\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([ALLOWED]);
  });
});
