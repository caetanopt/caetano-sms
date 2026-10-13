import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type DeleteMessageCommandOutput,
  type ReceiveMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import type { SmsJobQueueConfig } from "@/lib/aws/sqs-config";
import { finalizeIfDone, sendCampaignRecipient, type EngineDeps } from "./engine";
import { parseJob } from "./sqs-job-queue";

/** Subconjunto do cliente SQS usado pelo consumidor (mock nos testes). */
export type SqsConsumerClient = {
  send(command: ReceiveMessageCommand): Promise<ReceiveMessageCommandOutput>;
  send(command: DeleteMessageCommand): Promise<DeleteMessageCommandOutput>;
};

type SqsConfig = Extract<SmsJobQueueConfig, { kind: "sqs" }>;

export type PollResult = { received: number; processed: number; discarded: number; failed: number };

/**
 * Uma receção (long polling) e o processamento sequencial das mensagens.
 *
 * Garantias (SQS entrega pelo menos uma vez):
 * - `sendCampaignRecipient` só atua se o destinatário ainda estiver PROCESSING com o mesmo
 *   `claimToken`; repetições e mensagens atrasadas não fazem nada;
 * - a chave de idempotência do SmsMessage impede um segundo pedido à AWS para a mesma
 *   tentativa, mesmo que o worker morra a meio (fica UNKNOWN pela reconciliação);
 * - a mensagem só é apagada depois de processada; em erro volta a ficar visível e, após
 *   `maxReceiveCount`, vai para a DLQ configurada na fila;
 * - mensagens inválidas são apagadas (nunca conseguiriam ser processadas).
 */
export async function pollSmsJobsOnce(
  input: { client: SqsConsumerClient; config: SqsConfig; engine: EngineDeps; waitTimeSeconds?: number; shouldStop?: () => boolean },
): Promise<PollResult> {
  const { client, config, engine } = input;
  const response = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: config.queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: input.waitTimeSeconds ?? 20,
      VisibilityTimeout: config.visibilityTimeoutSeconds,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );
  const messages = response.Messages ?? [];
  const result: PollResult = { received: messages.length, processed: 0, discarded: 0, failed: 0 };

  for (const message of messages) {
    // Em paragem, as restantes voltam a ficar visíveis após o visibility timeout.
    if (input.shouldStop?.()) break;
    const remove = () => client.send(new DeleteMessageCommand({ QueueUrl: config.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    const job = parseJob(message.Body);
    if (!job || !message.ReceiptHandle) {
      engine.logger.log("warn", "sms.job.discarded", { errorCode: "INVALID_JOB" });
      if (message.ReceiptHandle) await remove();
      result.discarded += 1;
      continue;
    }
    const startedAt = performance.now();
    try {
      await sendCampaignRecipient(job, engine);
      await finalizeIfDone(job.campaignId, engine);
      await remove();
      result.processed += 1;
      engine.logger.log("info", "sms.job.processed", {
        campaignId: job.campaignId,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      result.failed += 1;
      engine.logger.log("error", "sms.job.failed", {
        campaignId: job.campaignId,
        errorCode: error instanceof Error ? error.name : "Error",
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 0) || undefined,
      });
    }
  }
  return result;
}
