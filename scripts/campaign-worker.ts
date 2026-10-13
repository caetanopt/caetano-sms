/**
 * Worker de campanhas: `pnpm worker:campaigns`.
 * Processa em segundo plano as campanhas iniciadas por um operador, sem depender da
 * página aberta. Termina de forma graciosa em SIGTERM/SIGINT (acaba o passo em curso).
 */
import "dotenv/config";
import { defaultEngineDeps } from "@/server/services/campaigns/engine";
import { runWorkerOnce } from "@/server/services/campaigns/worker";
import { getMetricsConfig } from "@/lib/observability/config";
import { emitEmfSnapshot } from "@/server/services/observability";

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.info(JSON.stringify({ level: "info", event: "campaign.worker.stopping", signal }));
  });
}

async function main() {
  console.info(JSON.stringify({ level: "info", event: "campaign.worker.started" }));
  // Métricas EMF (CLAUDE.md §32): ativar num único worker para não duplicar pontos.
  let emf;
  try {
    emf = getMetricsConfig().emf;
  } catch (error) {
    console.error(JSON.stringify({ level: "error", event: "campaign.worker.invalid_configuration", reason: error instanceof Error ? error.message : "configuração inválida" }));
    process.exitCode = 1;
    return;
  }
  let nextEmfAt = 0;
  while (!stopping) {
    if (emf.enabled && Date.now() >= nextEmfAt) {
      nextEmfAt = Date.now() + emf.intervalMs;
      await emitEmfSnapshot(emf.namespace).catch(() =>
        console.error(JSON.stringify({ level: "error", event: "metrics.snapshot.failed" })),
      );
    }
    try {
      const { nextWaitMs } = await runWorkerOnce(defaultEngineDeps());
      await new Promise((resolve) => setTimeout(resolve, nextWaitMs));
    } catch (error) {
      console.error(
        JSON.stringify({ level: "error", event: "campaign.worker.error", errorName: error instanceof Error ? error.name : "Error" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  const { prisma } = await import("@/lib/db/prisma");
  await prisma.$disconnect();
  console.info(JSON.stringify({ level: "info", event: "campaign.worker.stopped" }));
}

void main();
