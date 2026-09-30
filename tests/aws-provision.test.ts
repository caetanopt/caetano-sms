import { describe, expect, it } from "vitest";
import {
  ALARMS,
  countryRuleUpdates,
  parseProvisionArgs,
  topicPolicy,
  type AlarmSpec,
  type ProvisionConfig,
} from "@/features/aws-provision/plan";
import { protectClientToken, runProvision, type AwsProvisionPort } from "@/server/services/aws-provision";

const ACCOUNT = "123456789012";
const env = { AWS_REGION: "eu-west-1" };
const parse = (...args: string[]) => parseProvisionArgs(["--account", ACCOUNT, ...args], env);
const config = (...args: string[]): ProvisionConfig => {
  const result = parse(...args);
  if (!result.ok) throw new Error(result.error);
  return result.config;
};

/** AWS simulada em memória: regista todas as escritas. */
class FakeAws implements AwsProvisionPort {
  writes: string[] = [];
  account = ACCOUNT;
  protectConfigs = new Map<string, Record<string, string>>();
  tokens = new Map<string, string>();
  sets = new Map<string, { protectId: string | null; destinations: { name: string; topicArn: string | null }[] }>();
  topics = new Map<string, string | undefined>();
  subscriptions: { topic: string; url: string }[] = [];
  queues = new Map<string, Record<string, string>>();
  alarms = new Map<string, { alarm: AlarmSpec; namespace: string; topic: string }>();
  countryBatches: Record<string, string>[] = [];
  constructor(
    readonly countries: string[] = ["PT", "ES", "FR", "US", "BR"],
    readonly initialStatus: (country: string) => string = () => "ALLOW",
  ) {}

  async callerAccount() {
    return this.account;
  }
  async discover(c: ProvisionConfig) {
    const set = this.sets.get(c.configurationSetName);
    const arn = `arn:aws:sns:${c.region}:${c.account}:${c.topicName}`;
    const policy = this.topics.get(arn);
    return {
      configurationSet: set
        ? { exists: true, protectConfigurationId: set.protectId, eventDestinations: set.destinations }
        : { exists: false, protectConfigurationId: null, eventDestinations: [] },
      countryRules: set?.protectId ? { ...this.protectConfigs.get(set.protectId)! } : null,
      topic: { exists: this.topics.has(arn), allowsSmsVoice: Boolean(policy?.includes("sms-voice.amazonaws.com")) },
      subscriptionExists: this.subscriptions.some((s) => s.topic === arn && s.url === c.webhookUrl),
      sqs: c.sqs ? { queueExists: this.queues.has(c.sqs.queueName), dlqExists: this.queues.has(c.sqs.dlqName) } : null,
      existingAlarms: [...this.alarms.keys()],
    };
  }
  async createProtectConfiguration(token: string) {
    this.writes.push("createProtectConfiguration");
    const existing = this.tokens.get(token);
    if (existing) return existing;
    const id = `protect-${this.protectConfigs.size + 1}`;
    this.tokens.set(token, id);
    this.protectConfigs.set(id, Object.fromEntries(this.countries.map((c) => [c, this.initialStatus(c)])));
    return id;
  }
  async getCountryRules(id: string) {
    return { ...this.protectConfigs.get(id)! };
  }
  async updateCountryRules(id: string, updates: Record<string, "ALLOW" | "BLOCK">) {
    this.writes.push("updateCountryRules");
    this.countryBatches.push(updates);
    Object.assign(this.protectConfigs.get(id)!, updates);
  }
  async createConfigurationSet(name: string) {
    this.writes.push("createConfigurationSet");
    this.sets.set(name, { protectId: null, destinations: [] });
  }
  async associateProtectConfiguration(id: string, name: string) {
    this.writes.push("associateProtectConfiguration");
    this.sets.get(name)!.protectId = id;
  }
  async createTopic(name: string) {
    this.writes.push("createTopic");
    const arn = `arn:aws:sns:eu-west-1:${ACCOUNT}:${name}`;
    if (!this.topics.has(arn)) this.topics.set(arn, undefined);
    return arn;
  }
  async setTopicPolicy(arn: string, policy: string) {
    this.writes.push("setTopicPolicy");
    this.topics.set(arn, policy);
  }
  async createEventDestination(set: string, name: string, arn: string) {
    this.writes.push("createEventDestination");
    this.sets.get(set)!.destinations.push({ name, topicArn: arn });
  }
  async subscribe(topic: string, url: string) {
    this.writes.push("subscribe");
    this.subscriptions.push({ topic, url });
  }
  async createQueue(name: string, attributes: Record<string, string>) {
    this.writes.push(`createQueue:${name}`);
    this.queues.set(name, attributes);
  }
  async putAlarm(alarm: AlarmSpec, namespace: string, topic: string) {
    this.writes.push(`putAlarm:${alarm.name}`);
    this.alarms.set(alarm.name, { alarm, namespace, topic });
  }
}

describe("parseProvisionArgs", () => {
  it("applies safe defaults: plan only, Portugal only, no SQS, no alarms", () => {
    expect(config()).toMatchObject({
      account: ACCOUNT,
      region: "eu-west-1",
      configurationSetName: "sms-app",
      eventDestinationName: "sms-app-sns",
      topicName: "sms-delivery-events",
      allowedCountries: ["PT"],
      webhookUrl: null,
      sqs: null,
      alarmTopicArn: null,
      apply: false,
    });
  });

  it("validates every input and refuses unknown options", () => {
    expect(parseProvisionArgs([], env)).toMatchObject({ ok: false, error: expect.stringMatching(/--account/) });
    expect(parseProvisionArgs(["--account", "123"], env)).toMatchObject({ ok: false });
    expect(parseProvisionArgs(["--account", ACCOUNT], {})).toMatchObject({ ok: false, error: expect.stringMatching(/Região/) });
    expect(parse("--countries", "PT,portugal")).toMatchObject({ ok: false });
    expect(parse("--countries", "pt, es")).toMatchObject({ ok: true, config: { allowedCountries: ["PT", "ES"] } });
    expect(parse("--topic", "bad name")).toMatchObject({ ok: false });
    expect(parse("--force")).toMatchObject({ ok: false });
    expect(parse("--unknown", "x")).toMatchObject({ ok: false, error: expect.stringMatching(/desconhecida/) });
    expect(parse("--region")).toMatchObject({ ok: false, error: expect.stringMatching(/Falta o valor/) });
    expect(parse("--help")).toMatchObject({ ok: false, error: expect.stringMatching(/^Uso:/) });
  });

  it("only accepts a public HTTPS webhook on the right path", () => {
    expect(parse("--webhook-url", "https://sms.example.pt/api/webhooks/aws-sms-events")).toMatchObject({ ok: true });
    for (const url of [
      "http://sms.example.pt/api/webhooks/aws-sms-events",
      "https://localhost/api/webhooks/aws-sms-events",
      "https://sms.example.pt/outro",
      "nao-e-url",
    ]) {
      expect(parse("--webhook-url", url)).toMatchObject({ ok: false });
    }
  });

  it("requires the alarm topic in the same region", () => {
    expect(parse("--alarm-topic-arn", `arn:aws:sns:eu-west-1:${ACCOUNT}:alertas`)).toMatchObject({ ok: true });
    expect(parse("--alarm-topic-arn", `arn:aws:sns:us-east-1:${ACCOUNT}:alertas`)).toMatchObject({ ok: false });
    expect(parse("--alarm-topic-arn", "alertas")).toMatchObject({ ok: false });
  });
});

describe("plan rules", () => {
  it("allows only the chosen countries", () => {
    expect(countryRuleUpdates({ PT: "BLOCK", ES: "ALLOW", FR: "BLOCK" }, ["PT"])).toEqual({ PT: "ALLOW", ES: "BLOCK" });
    expect(countryRuleUpdates({ PT: "ALLOW", ES: "BLOCK" }, ["PT"])).toEqual({});
    expect(countryRuleUpdates({ ES: "ALLOW" }, ["PT"])).toEqual({ ES: "BLOCK", PT: "ALLOW" });
  });

  it("restricts the topic policy to the SMS service of this account", () => {
    const policy = JSON.parse(topicPolicy(`arn:aws:sns:eu-west-1:${ACCOUNT}:t`, ACCOUNT));
    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Effect: "Allow",
        Principal: { Service: "sms-voice.amazonaws.com" },
        Action: "sns:Publish",
        Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } },
      }),
    ]);
  });

  it("uses a deterministic idempotency token for the Protect Configuration", () => {
    expect(protectClientToken(config())).toBe(protectClientToken(config()));
    expect(protectClientToken(config())).not.toBe(protectClientToken(config("--configuration-set", "outro")));
  });
});

describe("runProvision", () => {
  const full = () =>
    config("--webhook-url", "https://sms.example.pt/api/webhooks/aws-sms-events", "--with-sqs", "--alarm-topic-arn", `arn:aws:sns:eu-west-1:${ACCOUNT}:alertas`);

  it("plan mode never writes", async () => {
    const aws = new FakeAws();
    const result = await runProvision(full(), aws);
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(aws.writes).toEqual([]);
    if (result.ok) expect(result.plan.filter((i) => i.action).length).toBeGreaterThan(5);
  });

  it("refuses to run with credentials of another account", async () => {
    const aws = new FakeAws();
    aws.account = "999999999999";
    const result = await runProvision({ ...full(), apply: true }, aws);
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/999999999999.*Nada foi feito/) });
    expect(aws.writes).toEqual([]);
  });

  it("applies everything in dependency order on an empty account, then is idempotent", async () => {
    const aws = new FakeAws();
    const result = await runProvision({ ...full(), apply: true }, aws);
    expect(result.ok && result.applied).toBe(true);
    expect(aws.writes).toEqual([
      "createProtectConfiguration",
      "updateCountryRules",
      "createConfigurationSet",
      "associateProtectConfiguration",
      "createTopic",
      "setTopicPolicy",
      "createEventDestination",
      "subscribe",
      "createQueue:sms-jobs-dlq",
      "createQueue:sms-jobs",
      ...ALARMS.map((a) => `putAlarm:${a.name}`),
    ]);
    // Só PT permitido.
    expect(aws.protectConfigs.get("protect-1")).toEqual({ PT: "ALLOW", ES: "BLOCK", FR: "BLOCK", US: "BLOCK", BR: "BLOCK" });
    expect(aws.sets.get("sms-app")).toEqual({
      protectId: "protect-1",
      destinations: [{ name: "sms-app-sns", topicArn: `arn:aws:sns:eu-west-1:${ACCOUNT}:sms-delivery-events` }],
    });
    expect(JSON.parse(aws.queues.get("sms-jobs")!.RedrivePolicy)).toEqual({
      deadLetterTargetArn: `arn:aws:sqs:eu-west-1:${ACCOUNT}:sms-jobs-dlq`,
      maxReceiveCount: "5",
    });
    expect(aws.queues.get("sms-jobs")).toMatchObject({ SqsManagedSseEnabled: "true", VisibilityTimeout: "60" });
    expect(aws.alarms.get("sms-dlq-not-empty")).toMatchObject({ namespace: "SmsApp", topic: `arn:aws:sns:eu-west-1:${ACCOUNT}:alertas` });
    if (result.ok) {
      expect(result.env).toEqual([
        "AWS_REGION=eu-west-1",
        "AWS_SMS_CONFIGURATION_SET=sms-app",
        "AWS_SMS_PROTECT_CONFIGURATION_ID=protect-1",
        `AWS_SMS_EVENTS_SNS_TOPIC_ARN=arn:aws:sns:eu-west-1:${ACCOUNT}:sms-delivery-events`,
        "SMS_JOB_QUEUE=sqs",
        `AWS_SQS_SMS_JOBS_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/${ACCOUNT}/sms-jobs`,
        `AWS_SQS_SMS_JOBS_DLQ_URL=https://sqs.eu-west-1.amazonaws.com/${ACCOUNT}/sms-jobs-dlq`,
      ]);
    }

    // 2.ª execução: nada a fazer.
    aws.writes = [];
    const again = await runProvision({ ...full(), apply: true }, aws);
    expect(aws.writes).toEqual([]);
    if (again.ok) expect(again.plan.every((i) => i.action === null)).toBe(true);
  });

  it("allows before blocking and sends country updates in small batches", async () => {
    const countries = Array.from({ length: 60 }, (_, i) => `${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    // PT começa bloqueado e os restantes permitidos: o 1.º lote tem de permitir PT.
    const aws = new FakeAws([...countries, "PT"], (c) => (c === "PT" ? "BLOCK" : "ALLOW"));
    await runProvision({ ...config(), apply: true }, aws);
    expect(aws.countryBatches.every((b) => Object.keys(b).length <= 25)).toBe(true);
    expect(aws.countryBatches[0].PT).toBe("ALLOW");
    expect(Object.values(aws.protectConfigs.get("protect-1")!).filter((s) => s === "ALLOW")).toHaveLength(1);
  });

  it("repairs drifted country rules but never touches an event destination pointing elsewhere", async () => {
    const aws = new FakeAws();
    await runProvision({ ...config(), apply: true }, aws);
    aws.protectConfigs.get("protect-1")!.US = "ALLOW";
    aws.sets.get("sms-app")!.destinations = [{ name: "sms-app-sns", topicArn: "arn:aws:sns:eu-west-1:123456789012:outro" }];
    aws.writes = [];
    const result = await runProvision({ ...config(), apply: true }, aws);
    expect(aws.writes).toEqual(["updateCountryRules"]);
    expect(aws.protectConfigs.get("protect-1")!.US).toBe("BLOCK");
    if (result.ok) expect(result.plan.some((i) => /ATENÇÃO.*outro tópico/.test(i.description))).toBe(true);
  });

  it("resumes safely after a failure half-way (same Protect Configuration, nothing duplicated)", async () => {
    const aws = new FakeAws();
    const failing = Object.create(aws) as FakeAws;
    failing.createTopic = async () => {
      throw Object.assign(new Error("denied"), { name: "AuthorizationErrorException" });
    };
    await expect(runProvision({ ...config(), apply: true }, failing)).rejects.toThrow("denied");
    expect(aws.sets.get("sms-app")?.protectId).toBe("protect-1");
    aws.writes = [];
    await runProvision({ ...config(), apply: true }, aws);
    expect(aws.writes).toEqual(["createTopic", "setTopicPolicy", "createEventDestination"]);
    expect(aws.protectConfigs.size).toBe(1);
  });

  it("skips alarms that already exist (never overwritten)", async () => {
    const aws = new FakeAws();
    aws.alarms.set("sms-dlq-not-empty", { alarm: ALARMS[0], namespace: "Outro", topic: "x" });
    await runProvision({ ...full(), apply: true }, aws);
    expect(aws.writes.filter((w) => w.startsWith("putAlarm"))).toHaveLength(ALARMS.length - 1);
    expect(aws.alarms.get("sms-dlq-not-empty")?.namespace).toBe("Outro");
  });
});
