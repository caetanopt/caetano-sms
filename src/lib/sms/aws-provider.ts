import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
  type SendTextMessageCommandOutput,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { mapAwsSmsError } from "./aws-errors";
import { isDryRun, SmsConfigurationError } from "./config";
import type { SendSmsInput, SmsProvider, SmsSendResult } from "./types";

/** Subconjunto do cliente SDK usado pelo provider (permite injetar um mock nos testes). */
export type SmsVoiceClient = {
  send(command: SendTextMessageCommand): Promise<SendTextMessageCommandOutput>;
};

export type AwsSmsProviderOptions = {
  region: string;
  originationIdentity: string;
  configurationSetName?: string;
  protectConfigurationId?: string;
  defaultDryRun: boolean;
  client?: SmsVoiceClient;
};

export function awsSmsProviderOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AwsSmsProviderOptions {
  const region = env.AWS_REGION;
  if (!region) throw new SmsConfigurationError("AWS_REGION is required");
  const originationIdentity = env.AWS_SMS_ORIGINATION_IDENTITY;
  if (!originationIdentity) {
    throw new SmsConfigurationError("AWS_SMS_ORIGINATION_IDENTITY is required");
  }
  return {
    region,
    originationIdentity,
    configurationSetName: env.AWS_SMS_CONFIGURATION_SET || undefined,
    protectConfigurationId: env.AWS_SMS_PROTECT_CONFIGURATION_ID || undefined,
    defaultDryRun: isDryRun(env),
  };
}

/** Limites de tempo de um pedido à AWS (ver README: dimensionam o lease das campanhas). */
export const AWS_SMS_CONNECTION_TIMEOUT_MS = 3_000;
export const AWS_SMS_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cliente sem retries automáticos do SDK: SendTextMessage não é idempotente na AWS
 * (não há ClientToken), e o SDK repetiria por defeito até 3 vezes em 5xx/timeouts —
 * casos em que a mensagem pode já ter sido aceite. A aplicação decide os retries
 * (só para falhas garantidamente não enviadas, ex.: throttling).
 */
export function createSmsVoiceClient(region: string) {
  return new PinpointSMSVoiceV2Client({
    region,
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: AWS_SMS_CONNECTION_TIMEOUT_MS,
      requestTimeout: AWS_SMS_REQUEST_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
  });
}

export class AwsSmsProvider implements SmsProvider {
  private readonly client: SmsVoiceClient;
  private readonly options: AwsSmsProviderOptions;

  constructor(options: AwsSmsProviderOptions = awsSmsProviderOptionsFromEnv()) {
    this.options = options;
    this.client = options.client ?? createSmsVoiceClient(options.region);
  }

  async send(input: SendSmsInput): Promise<SmsSendResult> {
    const dryRun = input.dryRun ?? this.options.defaultDryRun;

    let response: SendTextMessageCommandOutput;
    try {
      response = await this.client.send(
        new SendTextMessageCommand({
          DestinationPhoneNumber: input.destinationPhoneNumber,
          OriginationIdentity: this.options.originationIdentity,
          MessageBody: input.messageBody,
          MessageType: input.messageType,
          ConfigurationSetName: this.options.configurationSetName,
          ProtectConfigurationId: this.options.protectConfigurationId,
          DryRun: dryRun,
          Context: input.context,
        }),
      );
    } catch (error) {
      return mapAwsSmsError(error);
    }

    if (response.MessageId) {
      return { ok: true, messageId: response.MessageId, provider: "aws" };
    }

    if (dryRun) {
      // Em dry-run a AWS valida o pedido mas pode não devolver MessageId.
      return { ok: true, messageId: `aws-dryrun_${crypto.randomUUID()}`, provider: "aws" };
    }

    // Pedido aceite (2xx) sem MessageId: não sabemos se foi enviado.
    return {
      ok: false,
      errorCode: "UNKNOWN",
      errorMessage: "A AWS aceitou o pedido mas não devolveu MessageId.",
      retryable: false,
      uncertain: true,
      providerRequestId: response.$metadata?.requestId,
    };
  }
}
