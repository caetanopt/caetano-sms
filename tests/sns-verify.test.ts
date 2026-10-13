import { beforeAll, describe, expect, it } from "vitest";
import { isAwsSnsUrl, verifySnsMessage } from "../src/lib/aws/sns-verify";
import { createTestSigner } from "./helpers/sns-signing";

const TOPIC = "arn:aws:sns:eu-west-1:123456789012:sms-events";
let signer: ReturnType<typeof createTestSigner>;

beforeAll(() => {
  signer = createTestSigner();
});

const now = new Date("2026-09-29T12:00:00Z");
const notification = (overrides: Record<string, string> = {}) =>
  signer.sign({
    Type: "Notification",
    MessageId: "11111111-2222-3333-4444-555555555555",
    TopicArn: TOPIC,
    Message: JSON.stringify({ eventType: "TEXT_DELIVERED" }),
    Timestamp: "2026-09-29T11:59:00.000Z",
    ...overrides,
  });

const deps = () => ({ fetchCertificate: signer.fetchCertificate, allowedTopicArns: [TOPIC], now: () => now });

describe("verifySnsMessage", () => {
  it("accepts correctly signed messages (SignatureVersion 1 and 2)", async () => {
    expect(await verifySnsMessage(notification(), deps())).toMatchObject({ ok: true });
    const v1 = signer.sign(
      { Type: "Notification", MessageId: "m1", TopicArn: TOPIC, Message: "{}", Timestamp: "2026-09-29T11:59:00.000Z" },
      "1",
    );
    expect(await verifySnsMessage(v1, deps())).toMatchObject({ ok: true });
  });

  it("rejects tampered messages", async () => {
    const envelope = notification();
    const tampered = { ...envelope, Message: JSON.stringify({ eventType: "TEXT_BLOCKED" }) };
    expect(await verifySnsMessage(tampered, deps())).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects other topics, foreign certificate URLs and old/future messages (replay)", async () => {
    expect(await verifySnsMessage(notification({ TopicArn: "arn:aws:sns:eu-west-1:999:other" }), deps())).toEqual({
      ok: false,
      reason: "topic_not_allowed",
    });
    const evil = { ...notification(), SigningCertURL: "https://evil.example.com/cert.pem" };
    expect(await verifySnsMessage(evil, deps())).toEqual({ ok: false, reason: "invalid_cert_url" });
    expect(await verifySnsMessage(notification({ Timestamp: "2026-09-29T10:00:00.000Z" }), deps())).toEqual({
      ok: false,
      reason: "stale_or_future_timestamp",
    });
    expect(await verifySnsMessage(notification({ Timestamp: "2026-09-29T12:30:00.000Z" }), deps())).toEqual({
      ok: false,
      reason: "stale_or_future_timestamp",
    });
  });

  it("rejects malformed envelopes", async () => {
    expect(await verifySnsMessage({ Type: "Notification" }, deps())).toEqual({ ok: false, reason: "invalid_envelope" });
    expect(await verifySnsMessage("x", deps())).toEqual({ ok: false, reason: "invalid_envelope" });
  });

  it("verifies subscription confirmations with their own canonical fields", async () => {
    const confirmation = signer.sign({
      Type: "SubscriptionConfirmation",
      MessageId: "m2",
      TopicArn: TOPIC,
      Message: "You have chosen to subscribe",
      Timestamp: "2026-09-29T11:59:00.000Z",
      Token: "tok",
      SubscribeURL: "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok",
    });
    expect(await verifySnsMessage(confirmation, deps())).toMatchObject({ ok: true });
  });
});

describe("isAwsSnsUrl", () => {
  it.each([
    ["https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem", true],
    ["http://sns.eu-west-1.amazonaws.com/x.pem", false],
    ["https://sns.eu-west-1.amazonaws.com.evil.com/x.pem", false],
    ["https://evil.com/sns.eu-west-1.amazonaws.com/x.pem", false],
    ["https://user@sns.eu-west-1.amazonaws.com/x.pem", false],
    ["https://sns.eu-west-1.amazonaws.com/x.txt", false],
  ])("%s → %s", (url, expected) => {
    expect(isAwsSnsUrl(url, "cert")).toBe(expected);
  });
});
