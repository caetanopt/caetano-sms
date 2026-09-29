/**
 * Worker de campanhas: `pnpm worker:campaigns`.
 * Processa em segundo plano as campanhas iniciadas por um operador, sem depender da
 * página aberta. Termina de forma graciosa em SIGTERM/SIGINT (acaba o passo em curso).
 */
import "dotenv/config";
import { defaultEngineDeps } from "@/server/services/campaigns/engine";
import { runWorkerOnce } from "@/server/services/campaigns/worker";

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.info(JSON.stringify({ level: "info", event: "campaign.worker.stopping", signal }));
  });
}

async function main() {
  console.info(JSON.stringify({ level: "info", event: "campaign.worker.started" }));
  while (!stopping) {
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
