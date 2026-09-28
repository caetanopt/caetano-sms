import {
  ConflictException,
  SendTextMessageCommand,
  type SendTextMessageCommandOutput,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { describe, expect, it } from "vitest";
import {
  AwsSmsProvider,
  awsSmsProviderOptionsFromEnv,
  type AwsSmsProviderOptions,
  type SmsVoiceClient,
} from "../src/lib/sms/aws-provider";

function mockClient(respond: (command: SendTextMessageCommand) => Promise<SendTextMessageCommandOutput>) {
  const calls: SendTextMessageCommand[] = [];
  const client: SmsVoiceClient = {
    send: async (command) => {
      calls.push(command);
      return respond(command);
    },
  };
  return { client, calls };
}

const baseOptions: Omit<AwsSmsProviderOptions, "client"> = {
  region: "eu-west-1",
  originationIdentity: "CAETANO",
  configurationSetName: "sms-events",
  protectConfigurationId: undefined,
  defaultDryRun: true,
};

const input = {
  destinationPhoneNumber: "+351912345678",
  messageBody: "Olá",
  messageType: "TRANSACTIONAL" as const,
  context: { internalMessageId: "msg_1", source: "manual" },
};

describe("AwsSmsProvider", () => {
  it("builds SendTextMessage with configured identity, config set and context", async () => {
    const { client, calls } = mockClient(async () => ({ MessageId: "aws-1", $metadata: {} }));
    const provider = new AwsSmsProvider({ ...baseOptions, client });

    const result = await provider.send({ ...input, dryRun: false });

    expect(result).toEqual({ ok: true, messageId: "aws-1", provider: "aws" });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({
      DestinationPhoneNumber: "+351912345678",
      OriginationIdentity: "CAETANO",
      MessageBody: "Olá",
      MessageType: "TRANSACTIONAL",
      ConfigurationSetName: "sms-events",
      ProtectConfigurationId: undefined,
      DryRun: false,
      Context: { internalMessageId: "msg_1", source: "manual" },
    });
  });

  it("defaults to the configured dry-run value when input does not specify it", async () => {
    const { client, calls } = mockClient(async () => ({ MessageId: "aws-1", $metadata: {} }));
    await new AwsSmsProvider({ ...baseOptions, client }).send(input);
    expect(calls[0].input.DryRun).toBe(true);
  });

  it("accepts a dry-run response without MessageId", async () => {
    const { client } = mockClient(async () => ({ $metadata: {} }));
    const result = await new AwsSmsProvider({ ...baseOptions, client }).send({ ...input, dryRun: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.messageId).toMatch(/^aws-dryrun_/);
  });

  it("treats a real send without MessageId as uncertain", async () => {
    const { client } = mockClient(async () => ({ $metadata: { requestId: "req-9" } }));
    const result = await new AwsSmsProvider({ ...baseOptions, client }).send({ ...input, dryRun: false });
    expect(result).toMatchObject({ ok: false, uncertain: true, retryable: false, providerRequestId: "req-9" });
  });

  it("maps SDK exceptions instead of throwing", async () => {
    const { client } = mockClient(async () => {
      throw new ConflictException({
        message: "opted out",
        Reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT",
        $metadata: { requestId: "req-2" },
      });
    });
    const result = await new AwsSmsProvider({ ...baseOptions, client }).send(input);
    expect(result).toMatchObject({ ok: false, errorCode: "OPTED_OUT", retryable: false, providerRequestId: "req-2" });
  });
});

describe("awsSmsProviderOptionsFromEnv", () => {
  const env = { AWS_REGION: "eu-west-1", AWS_SMS_ORIGINATION_IDENTITY: "CAETANO" };

  it("requires region and origination identity", () => {
    expect(() => awsSmsProviderOptionsFromEnv({ AWS_SMS_ORIGINATION_IDENTITY: "X" })).toThrow(/AWS_REGION/);
    expect(() => awsSmsProviderOptionsFromEnv({ AWS_REGION: "eu-west-1" })).toThrow(/ORIGINATION/);
  });

  it("turns empty optional values into undefined", () => {
    const options = awsSmsProviderOptionsFromEnv({
      ...env,
      AWS_SMS_CONFIGURATION_SET: "",
      AWS_SMS_PROTECT_CONFIGURATION_ID: "",
    });
    expect(options.configurationSetName).toBeUndefined();
    expect(options.protectConfigurationId).toBeUndefined();
  });

  it.each([
    [undefined, true],
    ["", true],
    ["true", true],
    ["FALSE", true],
    ["0", true],
    ["false", false],
  ])("AWS_SMS_DRY_RUN=%s => dry-run %s", (value, expected) => {
    expect(awsSmsProviderOptionsFromEnv({ ...env, AWS_SMS_DRY_RUN: value }).defaultDryRun).toBe(expected);
  });
});
