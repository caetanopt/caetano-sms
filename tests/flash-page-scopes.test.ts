import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP = new URL("../src/app", import.meta.url).pathname;

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return name === "page.tsx" ? [path] : [];
  });
}

/** Rota do ficheiro (sem grupos "(…)"), com `[id]` como `${encodeURIComponent(id)}`. */
function expectedScope(file: string): string {
  const segments = relative(APP, file)
    .split(sep)
    .slice(0, -1)
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => segment.replace(/^\[(\w+)\]$/, "${encodeURIComponent($1)}"));
  const route = `/${segments.join("/")}`;
  return route.includes("${") ? `\`${route}\`` : `"${route}"`;
}

// Uma mensagem só é aceite na página para onde foi assinada: cada página tem de indicar a SUA rota
// a readFlash (um caminho errado faria desaparecer as mensagens legítimas dessa página).
describe("readFlash nas páginas", () => {
  const withFlash = pages(APP).filter((file) => readFileSync(file, "utf8").includes("readFlash("));

  it("as páginas que mostram mensagens usam readFlash", () => {
    expect(withFlash.length).toBeGreaterThanOrEqual(14);
  });

  it.each(withFlash.map((file) => [relative(APP, file), file]))("%s indica a sua própria rota", (_name, file) => {
    const source = readFileSync(file, "utf8");
    const calls = [...source.matchAll(/readFlash\([^,]+,\s*(`[^`]*`|"[^"]*")\s*\)/g)].map((m) => m[1]);
    expect(calls).toEqual([expectedScope(file)]);
  });
});
