import { SmsConfigurationError } from "@/lib/sms/config";

/**
 * Fila de jobs de envio (CLAUDE.md §17):
 * - `direct` (defeito): o job corre dentro do passo da campanha (MVP);
 * - `sqs`: o passo publica o job no Amazon SQS e `pnpm worker:sms-jobs` envia.
 */
export type SmsJobQueueConfig =
  | { kind: "direct" }
  | {
      kind: "sqs";
      region: string;
      queueUrl: string;
      fifo: boolean;
      /** Máximo de destinatários em PROCESSING por campanha (limita rajadas do consumidor). */
      maxInFlight: number;
      visibilityTimeoutSeconds: number;
      /** DLQ, só para métricas (profundidade). Opcional. */
      dlqUrl?: string;
    };

type Env = Record<string, string | undefined>;

const QUEUE_URL = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,75}(\.fifo)?$/;

function readInt(env: Env, key: string, fallback: number, min: number, max: number) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new SmsConfigurationError(`${key} deve ser um inteiro entre ${min} e ${max}`);
  }
  return value;
}

export function getSmsJobQueueConfig(env: Env = process.env): SmsJobQueueConfig {
  const kind = env.SMS_JOB_QUEUE ?? "direct";
  if (kind === "direct" || kind === "") return { kind: "direct" };
  if (kind !== "sqs") throw new SmsConfigurationError(`SMS_JOB_QUEUE inválido: ${kind}`);

  const region = env.AWS_REGION;
  if (!region) throw new SmsConfigurationError("AWS_REGION is required for SMS_JOB_QUEUE=sqs");
  const queueUrl = env.AWS_SQS_SMS_JOBS_QUEUE_URL ?? "";
  const match = QUEUE_URL.exec(queueUrl);
  if (!match) throw new SmsConfigurationError("AWS_SQS_SMS_JOBS_QUEUE_URL inválido (https://sqs.<região>.amazonaws.com/<conta>/<fila>)");
  // Todos os recursos na região da aplicação (CLAUDE.md §7).
  if (match[1] !== region) throw new SmsConfigurationError("A fila SQS tem de estar na região AWS_REGION");

  const dlqRaw = env.AWS_SQS_SMS_JOBS_DLQ_URL ?? "";
  let dlqUrl: string | undefined;
  if (dlqRaw !== "") {
    const dlq = QUEUE_URL.exec(dlqRaw);
    if (!dlq || dlq[1] !== region) throw new SmsConfigurationError("AWS_SQS_SMS_JOBS_DLQ_URL inválido ou fora de AWS_REGION");
    dlqUrl = dlqRaw;
  }

  return {
    kind: "sqs",
    dlqUrl,
    region,
    queueUrl,
    fifo: match[2] === ".fifo",
    maxInFlight: readInt(env, "SMS_SQS_MAX_IN_FLIGHT", 10, 1, 100),
    // Um envio demora no máximo ~13 s (timeouts do SDK) + base de dados: margem ampla.
    visibilityTimeoutSeconds: readInt(env, "SMS_SQS_VISIBILITY_TIMEOUT_SECONDS", 60, 30, 900),
  };
}
