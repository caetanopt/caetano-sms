/**
 * Guarda dos advisories aceites em `pnpm-workspace.yaml` (`audit.ignore`).
 *
 * O pnpm ignora um GHSA em todos os caminhos de dependências. A justificação de cada advisory
 * aceite assume que o pacote afetado não está na árvore de produção; este script falha se:
 * - houver um GHSA ignorado sem entrada em ACCEPTED (justificação por rever), ou
 * - algum pacote afetado aparecer em `pnpm why <pacote> --prod`.
 *
 * Uso: `pnpm audit:deps` (corre `pnpm audit` e depois este script).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ACCEPTED: Record<string, { packages: string[]; reason: string }> = {
  "GHSA-vfj7-8cjw-p6xm": {
    packages: ["braces", "micromatch", "fast-glob"],
    reason: "braces <=3.0.3 sem versão corrigida; só na cadeia de lint (eslint-config-next)",
  },
};

const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
// Itens de lista YAML (`- GHSA-…`); os comentários com GHSA não contam.
const ignored = [...new Set([...workspace.matchAll(/^\s*-\s*["']?(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})["']?\s*$/gim)].map((m) => m[1]))];

const problems: string[] = [];
for (const ghsa of ignored) {
  if (!ACCEPTED[ghsa]) problems.push(`${ghsa} está em audit.ignore sem justificação em scripts/check-audit-ignores.ts`);
}
for (const [ghsa, { packages }] of Object.entries(ACCEPTED)) {
  if (!ignored.includes(ghsa)) continue;
  for (const pkg of packages) {
    const out = execFileSync("pnpm", ["why", pkg, "--prod"], { encoding: "utf8" }).trim();
    if (out) problems.push(`${ghsa}: "${pkg}" entrou na árvore de produção — rever a aceitação:\n${out}`);
  }
}

if (problems.length > 0) {
  console.error(`Advisories aceites por rever:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Advisories aceites verificados (${ignored.join(", ") || "nenhum"}): fora da árvore de produção.`);
