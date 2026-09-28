import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import type { SendSmsInput, SmsProvider, SmsSendResult } from "./types";

export class AwsSmsProvider implements SmsProvider {
  private readonly client: PinpointSMSVoiceV2Client;

  constructor() {
    const region = process.env.AWS_REGION;
    if (!region) throw new Error("AWS_REGION is required");
    this.client = new PinpointSMSVoiceV2Client({ region });
  }

  async send(input: SendSmsInput): Promise<SmsSendResult> {
    const originationIdentity = process.env.AWS_SMS_ORIGINATION_IDENTITY;
    if (!originationIdentity) {
      return {
        ok: false,
        errorCode: "CONFIGURATION_ERROR",
        errorMessage: "AWS_SMS_ORIGINATION_IDENTITY não está configurado.",
        retryable: false,
      };
    }

    try {
      const result = await this.client.send(
        new SendTextMessageCommand({
          DestinationPhoneNumber: input.destinationPhoneNumber,
          OriginationIdentity: originationIdentity,
          MessageBody: input.messageBody,
          MessageType: input.messageType,
          ConfigurationSetName: process.env.AWS_SMS_CONFIGURATION_SET || undefined,
          ProtectConfigurationId: process.env.AWS_SMS_PROTECT_CONFIGURATION_ID || undefined,
          DryRun: input.dryRun ?? process.env.AWS_SMS_DRY_RUN !== "false",
          Context: input.context,
        }),
      );

      if (!result.MessageId) {
        return {
          ok: false,
          errorCode: "UNKNOWN",
          errorMessage: "A AWS não devolveu MessageId.",
          retryable: true,
        };
      }

      return { ok: true, messageId: result.MessageId, provider: "aws" };
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      const throttled = name.includes("Throttl") || name.includes("TooManyRequests");
      return {
        ok: false,
        errorCode: throttled ? "THROTTLED" : "PROVIDER_ERROR",
        errorMessage: throttled
          ? "A AWS aplicou throttling. Tenta novamente mais tarde."
          : "Não foi possível enviar a mensagem através da AWS.",
        retryable: throttled,
      };
    }
  }
}
