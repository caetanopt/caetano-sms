/**
 * Retenção de dados (CLAUDE.md §13): `pnpm retention` simula; `pnpm retention --apply` aplica.
 * Agendar diariamente (cron) em produção, depois de validar os prazos com o DPO.
 */
import "dotenv/config";
import { getRetentionPolicy } from "@/features/retention/policy";
import { runRetention } from "@/server/services/retention";

const apply = process.argv.includes("--apply");
const policy = getRetentionPolicy();
const report = await runRetention(policy, { apply });
console.info(JSON.stringify({ level: "info", event: apply ? "retention.applied" : "retention.dry_run", policy, ...report }));
if (!apply) console.info("Simulação: nada foi alterado. Usa --apply para aplicar.");
const { prisma } = await import("@/lib/db/prisma");
await prisma.$disconnect();
