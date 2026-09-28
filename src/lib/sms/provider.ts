import { AwsSmsProvider } from "./aws-provider";
import { FakeSmsProvider } from "./fake-provider";
import type { SmsProvider } from "./types";

export function getSmsProvider(): SmsProvider {
  const provider = process.env.SMS_PROVIDER ?? "fake";
  if (provider === "fake") return new FakeSmsProvider();
  if (provider === "aws") return new AwsSmsProvider();
  throw new Error(`SMS_PROVIDER inválido: ${provider}`);
}
