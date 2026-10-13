import { SendMessageCommand, SQSClient, type SendMessageCommandOutput } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { SmsJobQueueConfig } from "@/lib/aws/sqs-config";
import type { SendSmsJob, SmsJobQueue } from "./engine";

/**
 * Corpo da mensagem SQS: só identificadores (sem números, nomes nem texto — CLAUDE.md §13).
 * O `claimToken` é a garantia de exatamente-uma-vez do lado da aplicação: uma mensagem
 * repetida ou atrasada cujo token já não corresponde ao destinatário não faz nada.
 */
const jobSchema = z.object({
  v: z.literal(1),
  campaignId: z.string().min(1).max(64),
  recipientId: z.string().min(1).max(64),
  claimToken: z.uuid(),
});

export function serializeJob(job: SendSmsJob): string {
  return JSON.stringify({ v: 1, ...job });
}

export function parseJob(body: string | undefined): SendSmsJob | null {
  if (!body || body.length > 1_000) return null;
  try {
    const parsed = jobSchema.safeParse(JSON.parse(body));
    if (!parsed.success) return null;
    const { campaignId, recipientId, claimToken } = parsed.data;
    return { campaignId, recipientId, claimToken };
  } catch {
    return null;
  }
}

/** Subconjunto do cliente SQS usado (permite injetar um mock nos testes). */
export type SqsSender = { send(command: SendMessageCommand): Promise<SendMessageCommandOutput> };

type SqsConfig = Extract<SmsJobQueueConfig, { kind: "sqs" }>;

export function createSqsClient(config: Pick<SqsConfig, "region">) {
  // Retries do SDK são seguros aqui: mensagens duplicadas são inofensivas (ver claimToken).
  return new SQSClient({ region: config.region, maxAttempts: 3 });
}

export class SqsSmsJobQueue implements SmsJobQueue {
  readonly maxInFlight: number;

  constructor(
    private readonly config: SqsConfig,
    private readonly client: SqsSender = createSqsClient(config),
  ) {
    this.maxInFlight = config.maxInFlight;
  }

  async enqueue(job: SendSmsJob): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.config.queueUrl,
        MessageBody: serializeJob(job),
        // FIFO: ordem por campanha e deduplicação por reserva.
        ...(this.config.fifo ? { MessageGroupId: job.campaignId, MessageDeduplicationId: job.claimToken } : {}),
      }),
    );
  }
}
