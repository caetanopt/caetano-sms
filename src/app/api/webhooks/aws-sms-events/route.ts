import { fetchSnsCertificate } from "@/lib/aws/sns-verify";
import { consoleLogger } from "@/lib/logging/logger";
import { PrismaSmsDeliveryEventHandler } from "@/server/services/delivery-events";
import { allowedTopicsFromEnv, confirmSnsSubscription, handleSnsWebhook, MAX_SNS_BODY_BYTES } from "@/server/services/sns-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recetor HTTPS de eventos de entrega (Configuration Set → SNS → aqui).
 * Sem sessão: a autenticidade vem da assinatura SNS + tópico autorizado + janela temporal.
 * Desativado (404) enquanto AWS_SMS_EVENTS_SNS_TOPIC_ARN não estiver definido.
 */
export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_SNS_BODY_BYTES) return new Response("too large", { status: 413 });
  const body = await request.text();
  try {
    const result = await handleSnsWebhook(body, {
      allowedTopicArns: allowedTopicsFromEnv(),
      fetchCertificate: fetchSnsCertificate,
      now: () => new Date(),
      handler: new PrismaSmsDeliveryEventHandler(consoleLogger),
      confirmSubscription: confirmSnsSubscription,
      logger: consoleLogger,
    });
    return new Response(result.body, { status: result.status });
  } catch {
    consoleLogger.log("error", "sms.event.error", {});
    // 500 → o SNS volta a tentar; o processamento é idempotente.
    return new Response("error", { status: 500 });
  }
}
