import { AwsSmsProvider, awsSmsProviderOptionsFromEnv } from "./aws-provider";
import { parseProviderName } from "./config";
import { FakeSmsProvider, fakeSmsProviderOptionsFromEnv } from "./fake-provider";
import type { SmsProvider } from "./types";

/** Lança SmsConfigurationError se a configuração do provider for inválida. */
export function getSmsProvider(env: Record<string, string | undefined> = process.env): SmsProvider {
  const provider = parseProviderName(env);
  if (provider === "aws") return new AwsSmsProvider(awsSmsProviderOptionsFromEnv(env));
  return new FakeSmsProvider(fakeSmsProviderOptionsFromEnv(env));
}
