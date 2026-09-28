import type { SendSmsInput, SmsProvider, SmsSendResult } from "./types";

export class FakeSmsProvider implements SmsProvider {
  async send(input: SendSmsInput): Promise<SmsSendResult> {
    if (!input.destinationPhoneNumber.startsWith("+")) {
      return {
        ok: false,
        errorCode: "INVALID_PHONE_NUMBER",
        errorMessage: "O número não está em E.164.",
        retryable: false,
      };
    }

    return {
      ok: true,
      messageId: `fake_${crypto.randomUUID()}`,
      provider: "fake",
    };
  }
}
