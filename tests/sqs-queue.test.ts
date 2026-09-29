import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { getSmsJobQueueConfig } from "@/lib/aws/sqs-config";
import { parseJob, serializeJob, SqsSmsJobQueue } from "@/server/services/campaigns/sqs-job-queue";

const URL_STD = "https://sqs.eu-west-1.amazonaws.com/123456789012/sms-jobs";
const URL_FIFO = "https://sqs.eu-west-1.amazonaws.com/123456789012/sms-jobs.fifo";
const job = { campaignId: "c1", recipientId: "r1", claimToken: "0b8f9f1e-6c4a-4d38-9d53-6f0f8f4f2a11" };

describe("getSmsJobQueueConfig", () => {
  it("defaults to the direct queue", () => {
    expect(getSmsJobQueueConfig({})).toEqual({ kind: "direct" });
    expect(getSmsJobQueueConfig({ SMS_JOB_QUEUE: "direct" })).toEqual({ kind: "direct" });
  });

  it("parses an SQS configuration", () => {
    expect(getSmsJobQueueConfig({ SMS_JOB_QUEUE: "sqs", AWS_REGION: "eu-west-1", AWS_SQS_SMS_JOBS_QUEUE_URL: URL_FIFO })).toEqual({
      kind: "sqs",
      region: "eu-west-1",
      queueUrl: URL_FIFO,
      fifo: true,
      maxInFlight: 10,
      visibilityTimeoutSeconds: 60,
    });
  });

  it("fails safely on invalid configuration", () => {
    const base = { SMS_JOB_QUEUE: "sqs", AWS_REGION: "eu-west-1", AWS_SQS_SMS_JOBS_QUEUE_URL: URL_STD };
    expect(() => getSmsJobQueueConfig({ SMS_JOB_QUEUE: "kafka" })).toThrow(/SMS_JOB_QUEUE/);
    expect(() => getSmsJobQueueConfig({ ...base, AWS_REGION: undefined })).toThrow(/AWS_REGION/);
    expect(() => getSmsJobQueueConfig({ ...base, AWS_SQS_SMS_JOBS_QUEUE_URL: "http://sqs.eu-west-1.amazonaws.com/123456789012/x" })).toThrow(/URL/);
    expect(() => getSmsJobQueueConfig({ ...base, AWS_SQS_SMS_JOBS_QUEUE_URL: "https://evil.example.com/123456789012/x" })).toThrow(/URL/);
    expect(() => getSmsJobQueueConfig({ ...base, AWS_REGION: "us-east-1" })).toThrow(/região/);
    expect(() => getSmsJobQueueConfig({ ...base, SMS_SQS_VISIBILITY_TIMEOUT_SECONDS: "10" })).toThrow(/VISIBILITY/);
    expect(() => getSmsJobQueueConfig({ ...base, SMS_SQS_MAX_IN_FLIGHT: "0" })).toThrow(/IN_FLIGHT/);
  });
});

describe("job serialization", () => {
  it("round-trips and contains only identifiers", () => {
    const body = serializeJob(job);
    expect(JSON.parse(body)).toEqual({ v: 1, ...job });
    expect(parseJob(body)).toEqual(job);
  });

  it("rejects malformed or unexpected bodies", () => {
    expect(parseJob(undefined)).toBeNull();
    expect(parseJob("not json")).toBeNull();
    expect(parseJob(JSON.stringify({ ...job, v: 2 }))).toBeNull();
    expect(parseJob(JSON.stringify({ v: 1, ...job, claimToken: "x" }))).toBeNull();
    expect(parseJob(JSON.stringify({ v: 1, campaignId: "c1" }))).toBeNull();
    expect(parseJob("x".repeat(2_000))).toBeNull();
  });
});

describe("SqsSmsJobQueue", () => {
  const client = () => {
    const sent: SendMessageCommand[] = [];
    return { sent, client: { send: async (command: SendMessageCommand) => (sent.push(command), { $metadata: {} }) } };
  };
  const config = (queueUrl: string, fifo: boolean) =>
    ({ kind: "sqs", region: "eu-west-1", queueUrl, fifo, maxInFlight: 5, visibilityTimeoutSeconds: 60 }) as const;

  it("publishes to a standard queue", async () => {
    const { sent, client: c } = client();
    const queue = new SqsSmsJobQueue(config(URL_STD, false), c);
    expect(queue.maxInFlight).toBe(5);
    await queue.enqueue(job);
    expect(sent[0]).toBeInstanceOf(SendMessageCommand);
    expect(sent[0].input).toEqual({ QueueUrl: URL_STD, MessageBody: serializeJob(job) });
  });

  it("groups by campaign and deduplicates by claim on FIFO queues", async () => {
    const { sent, client: c } = client();
    await new SqsSmsJobQueue(config(URL_FIFO, true), c).enqueue(job);
    expect(sent[0].input).toMatchObject({ MessageGroupId: "c1", MessageDeduplicationId: job.claimToken });
  });
});
