import { SmsConfigurationError } from "./config";
import type { SendSmsInput, SmsProvider, SmsSendFailure, SmsSendResult } from "./types";

export const FAKE_SCENARIOS = [
  "success",
  "failure",
  "throttle",
  "opt_out",
  "uncertain",
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number];

export type FakeSmsProviderOptions = {
  scenario?: FakeScenario;
  delayMs?: number;
};

const FAILURES: Record<Exclude<FakeScenario, "success">, SmsSendFailure> = {
  failure: {
    ok: false,
    errorCode: "VALIDATION_ERROR",
    errorMessage: "Falha simulada pelo provider fake.",
    retryable: false,
    uncertain: false,
    providerErrorName: "FakeValidationException",
  },
  throttle: {
    ok: false,
    errorCode: "THROTTLED",
    errorMessage: "Throttling simulado pelo provider fake. Não foi enviado.",
    retryable: true,
    uncertain: false,
    providerErrorName: "FakeThrottlingException",
  },
  opt_out: {
    ok: false,
    errorCode: "OPTED_OUT",
    errorMessage: "Opt-out simulado pelo provider fake. Não foi enviado.",
    retryable: false,
    uncertain: false,
    providerErrorName: "FakeConflictException",
  },
  uncertain: {
    ok: false,
    errorCode: "UNKNOWN",
    errorMessage: "Timeout simulado pelo provider fake: resultado incerto.",
    retryable: false,
    uncertain: true,
    providerErrorName: "FakeTimeoutError",
  },
};

export function fakeSmsProviderOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): FakeSmsProviderOptions {
  const scenario = env.SMS_FAKE_SCENARIO || "success";
  if (!(FAKE_SCENARIOS as readonly string[]).includes(scenario)) {
    throw new SmsConfigurationError(`SMS_FAKE_SCENARIO inválido: ${scenario}`);
  }
  const delayMs = Number(env.SMS_FAKE_DELAY_MS || 0);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
    throw new SmsConfigurationError("SMS_FAKE_DELAY_MS deve ser um inteiro entre 0 e 30000");
  }
  return { scenario: scenario as FakeScenario, delayMs };
}

/** Provider para desenvolvimento e testes: nunca contacta a AWS. */
export class FakeSmsProvider implements SmsProvider {
  private readonly scenario: FakeScenario;
  private readonly delayMs: number;

  constructor(options: FakeSmsProviderOptions = {}) {
    this.scenario = options.scenario ?? "success";
    this.delayMs = options.delayMs ?? 0;
  }

  async send(input: SendSmsInput): Promise<SmsSendResult> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (!input.destinationPhoneNumber.startsWith("+")) {
      return {
        ok: false,
        errorCode: "INVALID_PHONE_NUMBER",
        errorMessage: "O número não está em E.164.",
        retryable: false,
        uncertain: false,
      };
    }

    if (this.scenario !== "success") return FAILURES[this.scenario];

    return {
      ok: true,
      messageId: `fake_${crypto.randomUUID()}`,
      provider: "fake",
    };
  }
}
