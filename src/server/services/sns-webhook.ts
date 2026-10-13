import { isAwsSnsUrl, verifySnsMessage, type SnsVerifyDeps } from "@/lib/aws/sns-verify";
import { parseSmsEvent } from "@/features/delivery/events";
import type { Logger } from "@/lib/logging/logger";
import type { SmsDeliveryEventHandler } from "./delivery-events";

export const MAX_SNS_BODY_BYTES = 300 * 1024;

export type SnsWebhookDeps = SnsVerifyDeps & {
  handler: SmsDeliveryEventHandler;
  /** Confirma a subscrição (GET ao SubscribeURL já validado). */
  confirmSubscription: (url: string) => Promise<void>;
  logger: Logger;
};

export type SnsWebhookResult = { status: number; body: string };

/** Tópicos autorizados (AWS_SMS_EVENTS_SNS_TOPIC_ARN, separados por vírgula). */
export function allowedTopicsFromEnv(env: Record<string, string | undefined> = process.env) {
  return (env.AWS_SMS_EVENTS_SNS_TOPIC_ARN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function handleSnsWebhook(rawBody: string, deps: SnsWebhookDeps): Promise<SnsWebhookResult> {
  if (deps.allowedTopicArns.length === 0) return { status: 404, body: "not found" };
  if (Buffer.byteLength(rawBody) > MAX_SNS_BODY_BYTES) return { status: 413, body: "too large" };

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "bad request" };
  }

  const verified = await verifySnsMessage(json, deps);
  if (!verified.ok) {
    // Nunca registar o payload (pode conter o número de telefone).
    deps.logger.log("warn", "sms.event.rejected", { errorCode: verified.reason });
    return { status: 403, body: "forbidden" };
  }
  const { envelope } = verified;

  if (envelope.Type === "SubscriptionConfirmation") {
    if (!envelope.SubscribeURL || !isAwsSnsUrl(envelope.SubscribeURL, "subscribe")) {
      return { status: 400, body: "bad request" };
    }
    await deps.confirmSubscription(envelope.SubscribeURL);
    deps.logger.log("info", "sms.event.subscription_confirmed", {});
    return { status: 200, body: "subscribed" };
  }
  if (envelope.Type === "UnsubscribeConfirmation") {
    deps.logger.log("warn", "sms.event.unsubscribed", {});
    return { status: 200, body: "ok" };
  }

  const event = parseSmsEvent(envelope.Message);
  if (!event) {
    deps.logger.log("warn", "sms.event.unparseable", {});
    return { status: 200, body: "ignored" };
  }
  await deps.handler.handle(event, { snsMessageId: envelope.MessageId });
  return { status: 200, body: "ok" };
}

export async function confirmSnsSubscription(url: string) {
  if (!isAwsSnsUrl(url, "subscribe")) throw new Error("invalid subscribe url");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
