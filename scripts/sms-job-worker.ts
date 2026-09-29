/**
 * Consumidor da fila SQS de envios: `pnpm worker:sms-jobs` (requer SMS_JOB_QUEUE=sqs).
 * Os jobs são publicados pelo passo da campanha (página ou `pnpm worker:campaigns`).
 * Termina de forma graciosa em SIGTERM/SIGINT: acaba a mensagem em curso e não apaga as
 * restantes (voltam a ficar visíveis após o visibility timeout).
 */
import "dotenv/config";
import { getSmsJobQueueConfig } from "@/lib/aws/sqs-config";
import { defaultEngineDeps } from "@/server/services/campaigns/engine";
import { pollSmsJobsOnce } from "@/server/services/campaigns/sqs-consumer";
import { createSqsClient } from "@/server/services/campaigns/sqs-job-queue";

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.info(JSON.stringify({ level: "info", event: "sms.worker.stopping", signal }));
  });
}

const log = (level: "info" | "error", event: string, fields: Record<string, unknown> = {}) =>
  console[level](JSON.stringify({ level, event, time: new Date().toISOString(), ...fields }));

async function main() {
  let config;
  try {
    config = getSmsJobQueueConfig();
  } catch (error) {
    log("error", "sms.worker.invalid_configuration", { reason: error instanceof Error ? error.message : "configuração inválida" });
    process.exitCode = 1;
    return;
  }
  if (config.kind !== "sqs") {
    log("error", "sms.worker.not_configured", { reason: "SMS_JOB_QUEUE não é sqs" });
    process.exitCode = 1;
    return;
  }
  const client = createSqsClient(config);
  log("info", "sms.worker.started", { fifo: config.fifo, region: config.region });

  while (!stopping) {
    try {
      // Dependências recriadas a cada ciclo: alterações de ambiente exigem reinício, mas
      // o provider e a origem são sempre lidos da mesma forma que no passo da campanha.
      const result = await pollSmsJobsOnce({ client, config, engine: defaultEngineDeps(), shouldStop: () => stopping });
      if (result.received > 0) log("info", "sms.worker.batch", { ...result });
    } catch (error) {
      log("error", "sms.worker.error", { errorName: error instanceof Error ? error.name : "Error" });
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  const { prisma } = await import("@/lib/db/prisma");
  await prisma.$disconnect();
  client.destroy();
  log("info", "sms.worker.stopped");
}

void main();
