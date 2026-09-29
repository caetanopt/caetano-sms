import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { Actor } from "@/server/services/contacts";
import { createContact } from "@/server/services/contacts";
import { PrismaSmsDeliveryEventHandler } from "@/server/services/delivery-events";
import { handleSnsWebhook } from "@/server/services/sns-webhook";
import { createTestSigner } from "../helpers/sns-signing";
import { createActors, resetDatabase } from "./helpers";

const TOPIC = "arn:aws:sns:eu-west-1:123456789012:sms-events";
let signer: ReturnType<typeof createTestSigner>;
let actors: Record<"admin" | "operator" | "viewer", Actor>;
let snsCounter = 0;
const confirmed: string[] = [];

beforeAll(() => {
  signer = createTestSigner();
});
beforeEach(async () => {
  await resetDatabase();
  actors = await createActors();
  confirmed.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const quiet = { log: () => {} };
const deps = (topics = [TOPIC]) => ({
  allowedTopicArns: topics,
  fetchCertificate: signer.fetchCertificate,
  now: () => new Date(),
  handler: new PrismaSmsDeliveryEventHandler(quiet),
  confirmSubscription: async (url: string) => {
    confirmed.push(url);
  },
  logger: quiet,
});

function notification(event: Record<string, unknown>, messageId = `sns-${++snsCounter}`) {
  return JSON.stringify(
    signer.sign({
      Type: "Notification",
      MessageId: messageId,
      TopicArn: TOPIC,
      Message: JSON.stringify({
        eventVersion: "1.0",
        eventTimestamp: Date.now(),
        isFinal: false,
        destinationPhoneNumber: "+351912345678",
        ...event,
      }),
      Timestamp: new Date().toISOString(),
    }),
  );
}

async function message(overrides: Record<string, unknown> = {}) {
  return prisma.smsMessage.create({
    data: {
      idempotencyKey: crypto.randomUUID(),
      destinationPhoneE164: "+351912345678",
      messageType: "TRANSACTIONAL",
      body: "Olá",
      provider: "aws",
      status: "ACCEPTED",
      awsMessageId: "aws-1",
      createdById: actors.operator.id,
      ...overrides,
    },
  });
}

describe("delivery events webhook", () => {
  it("applies a signed DELIVERED event and records price without the phone number", async () => {
    const sms = await message();
    const result = await handleSnsWebhook(
      notification({ eventType: "TEXT_DELIVERED", messageId: "aws-1", isFinal: true, totalMessagePrice: 0.0421 }),
      deps(),
    );
    expect(result).toEqual({ status: 200, body: "ok" });
    const updated = await prisma.smsMessage.findUniqueOrThrow({ where: { id: sms.id } });
    expect(updated).toMatchObject({ status: "DELIVERED", lastEventType: "TEXT_DELIVERED" });
    expect(updated.deliveredAt).toBeInstanceOf(Date);
    const events = await prisma.smsDeliveryEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ applied: true, smsMessageId: sms.id });
    expect(events[0].priceUsd?.toString()).toBe("0.0421");
    expect(JSON.stringify(events)).not.toContain("912345678");
  });

  it("is idempotent for redelivered SNS notifications", async () => {
    await message();
    const body = notification({ eventType: "TEXT_DELIVERED", messageId: "aws-1" }, "same-sns-id");
    await handleSnsWebhook(body, deps());
    expect(await handleSnsWebhook(body, deps())).toEqual({ status: 200, body: "ok" });
    expect(await prisma.smsDeliveryEvent.count()).toBe(1);
  });

  it("tolerates out-of-order events and never overwrites final states", async () => {
    const sms = await message();
    await handleSnsWebhook(notification({ eventType: "TEXT_SENT", messageId: "aws-1" }), deps());
    await handleSnsWebhook(notification({ eventType: "TEXT_DELIVERED", messageId: "aws-1" }), deps());
    await handleSnsWebhook(notification({ eventType: "TEXT_QUEUED", messageId: "aws-1" }), deps());
    await handleSnsWebhook(notification({ eventType: "TEXT_BLOCKED", messageId: "aws-1" }), deps());
    expect((await prisma.smsMessage.findUniqueOrThrow({ where: { id: sms.id } })).status).toBe("DELIVERED");
    const applied = await prisma.smsDeliveryEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(applied.map((e) => e.applied)).toEqual([true, true, false, false]);
  });

  it("resolves uncertain messages via the internal id in Context and fixes the campaign recipient", async () => {
    const sms = await message({ status: "UNKNOWN", awsMessageId: null });
    const campaign = await prisma.campaign.create({
      data: { name: "c", messageType: "TRANSACTIONAL", messageBody: "x", status: "PARTIAL", createdById: actors.operator.id },
    });
    const recipient = await prisma.campaignRecipient.create({
      data: { campaignId: campaign.id, status: "UNKNOWN", messageId: sms.id },
    });
    await handleSnsWebhook(
      notification({ eventType: "TEXT_SUCCESSFUL", messageId: "aws-late", context: { internalMessageId: sms.id } }),
      deps(),
    );
    expect(await prisma.smsMessage.findUniqueOrThrow({ where: { id: sms.id } })).toMatchObject({
      status: "SENT",
      awsMessageId: "aws-late",
    });
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).toMatchObject({ status: "ACCEPTED" });
  });

  it("ignores an internal id whose message already has a different AWS id", async () => {
    const sms = await message({ awsMessageId: "aws-real" });
    await handleSnsWebhook(
      notification({ eventType: "TEXT_DELIVERED", messageId: "aws-other", context: { internalMessageId: sms.id } }),
      deps(),
    );
    expect((await prisma.smsMessage.findUniqueOrThrow({ where: { id: sms.id } })).status).toBe("ACCEPTED");
  });

  it("adds provider opt-outs from events to the suppression list", async () => {
    const contact = await createContact(actors.operator, {
      name: "Maria",
      phone: "912345678",
      consentStatus: "OPTED_IN",
      consent: { source: "loja", purpose: "marketing" },
    });
    if (!contact.ok) throw new Error("setup");
    await message({ contactId: contact.value.id });
    await handleSnsWebhook(
      notification({ eventType: "TEXT_BLOCKED", messageId: "aws-1", messageStatus: "DESTINATION_PHONE_NUMBER_OPTED_OUT" }),
      deps(),
    );
    expect(await prisma.suppressionEntry.findUnique({ where: { phoneE164: "+351912345678" } })).not.toBeNull();
    expect(await prisma.contact.findUniqueOrThrow({ where: { id: contact.value.id } })).toMatchObject({ consentStatus: "OPTED_OUT" });
  });

  it("records unmatched events without failing (SNS must not retry forever)", async () => {
    expect(await handleSnsWebhook(notification({ eventType: "TEXT_DELIVERED", messageId: "nobody" }), deps())).toEqual({
      status: 200,
      body: "ok",
    });
    expect(await prisma.smsDeliveryEvent.findFirstOrThrow()).toMatchObject({ applied: false, smsMessageId: null });
  });

  it("rejects forged or foreign messages and is disabled without a configured topic", async () => {
    await message();
    const forged = JSON.parse(notification({ eventType: "TEXT_DELIVERED", messageId: "aws-1" }));
    forged.Message = JSON.stringify({ eventType: "TEXT_BLOCKED", messageId: "aws-1" });
    expect(await handleSnsWebhook(JSON.stringify(forged), deps())).toEqual({ status: 403, body: "forbidden" });
    expect(await handleSnsWebhook(notification({ eventType: "TEXT_DELIVERED", messageId: "aws-1" }), deps(["arn:other"]))).toEqual({
      status: 403,
      body: "forbidden",
    });
    expect(await handleSnsWebhook("{}", deps([]))).toEqual({ status: 404, body: "not found" });
    expect(await handleSnsWebhook("not json", deps())).toEqual({ status: 400, body: "bad request" });
    expect(await prisma.smsDeliveryEvent.count()).toBe(0);
  });

  it("confirms subscriptions only for the allowed topic and AWS URLs", async () => {
    const confirmation = (url: string) =>
      JSON.stringify(
        signer.sign({
          Type: "SubscriptionConfirmation",
          MessageId: `sub-${++snsCounter}`,
          TopicArn: TOPIC,
          Message: "confirm",
          Timestamp: new Date().toISOString(),
          Token: "tok",
          SubscribeURL: url,
        }),
      );
    const good = "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=tok";
    expect(await handleSnsWebhook(confirmation(good), deps())).toEqual({ status: 200, body: "subscribed" });
    expect(await handleSnsWebhook(confirmation("https://evil.example.com/confirm"), deps())).toEqual({
      status: 400,
      body: "bad request",
    });
    expect(confirmed).toEqual([good]);
  });
});
