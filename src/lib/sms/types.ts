export type SmsMessageType = "TRANSACTIONAL" | "PROMOTIONAL";

export type SendSmsInput = {
  destinationPhoneNumber: string;
  messageBody: string;
  messageType: SmsMessageType;
  dryRun?: boolean;
  context?: Record<string, string>;
};

export type SmsSendResult =
  | {
      ok: true;
      messageId: string;
      provider: "aws" | "fake";
    }
  | {
      ok: false;
      errorCode: string;
      errorMessage: string;
      retryable: boolean;
    };

export interface SmsProvider {
  send(input: SendSmsInput): Promise<SmsSendResult>;
}
