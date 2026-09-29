import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { FakeSmsProvider, type FakeScenario } from "@/lib/sms/fake-provider";
import type { SendSmsInput, SmsProvider } from "@/lib/sms/types";
import { createCampaignDraft } from "@/server/services/campaign-drafts";
import { confirmCampaign } from "@/server/services/campaigns/confirm";
import {
  idempotencyKeyFor,
  processCampaignStep,
  recipientCounts,
  STALE_MS,
  type EngineDeps,
  type StepResult,
} from "@/server/services/campaigns/engine";
import { cancelCampaign, pauseCampaign, resumeCampaign, revertCampaignToDraft } from "@/server/services/campaigns/lifecycle";
import { currentOrigin } from "@/server/services/campaigns/origin";
import { pollSmsJobsOnce, type SqsConsumerClient } from "@/server/services/campaigns/sqs-consumer";
import { SqsSmsJobQueue } from "@/server/services/campaigns/sqs-job-queue";
import { buildCampaignPreview } from "@/server/services/campaigns/preview";
import { changeContactConsent, createContact, deleteContact, type Actor } from "@/server/services/contacts";
import { addContactToList, createList } from "@/server/services/lists";
import { reserveSendCapacity } from "@/server/services/send-rate";
import { createActors, resetDatabase } from "./helpers";

let actors: Record<"admin" | "operator" | "viewer", Actor>;
const optIn = { source: "loja", purpose: "marketing" };

beforeEach(async () => {
  await resetDatabase();
  actors = await createActors();
});
afterEach(() => {
  delete process.env.SMS_BULK_CONFIRMATION_THRESHOLD;
});
afterAll(async () => {
  await prisma.$disconnect();
});

class RecordingProvider implements SmsProvider {
  calls: SendSmsInput[] = [];
  constructor(public scenario: FakeScenario = "success") {}
  async send(input: SendSmsInput) {
    this.calls.push(input);
    return new FakeSmsProvider({ scenario: this.scenario }).send(input);
  }
}

const HIGH_RATE = { originMps: 1000, countryMps: {}, defaultCountryMps: 1000, burstSeconds: 1 };
const checkPerMinute = (maxPerMinute: number) =>
  reserveSendCapacity({ phoneE164: "+351912345678", segments: 1 }, { maxPerMinute, rate: HIGH_RATE, originKey: "test" });

function engine(provider: RecordingProvider, overrides: Partial<EngineDeps> = {}) {
  let clock = Date.now();
  const deps: EngineDeps = {
    origin: () => currentOrigin({ SMS_PROVIDER: "fake" }),
    getProvider: () => provider,
    logger: { log: () => {} },
    limits: { maxRecipients: 500, maxSendsPerMinute: 1000, batchSize: 10, bulkConfirmationThreshold: 50, maxAttempts: 3 },
    rate: HIGH_RATE,
    now: () => new Date(clock),
    random: () => 0.5,
    ...overrides,
  };
  return { deps, advance: (ms: number) => (clock += ms) };
}

/** Lista com contactos: `opted` = OPTED_IN, restantes UNKNOWN / OPTED_OUT. */
async function setup(options: { optedIn?: number; unknown?: number; optedOut?: number; messageType?: "TRANSACTIONAL" | "PROMOTIONAL" } = {}) {
  const list = await createList(actors.operator, { name: "Clientes" });
  if (!list.ok) throw new Error("list");
  const contactIds: string[] = [];
  let n = 0;
  const add = async (consentStatus: "OPTED_IN" | "UNKNOWN" | "OPTED_OUT") => {
    n += 1;
    const created = await createContact(actors.operator, {
      name: `Cliente${n} Silva`,
      phone: `91${String(1000000 + n).padStart(7, "0")}`,
      consentStatus,
      consent: optIn,
    });
    if (!created.ok) throw new Error(created.message);
    await addContactToList(actors.operator, list.value.id, created.value.id);
    contactIds.push(created.value.id);
  };
  for (let i = 0; i < (options.optedIn ?? 3); i += 1) await add("OPTED_IN");
  for (let i = 0; i < (options.unknown ?? 0); i += 1) await add("UNKNOWN");
  for (let i = 0; i < (options.optedOut ?? 0); i += 1) await add("OPTED_OUT");

  const draft = await createCampaignDraft(actors.operator, {
    name: "Outubro",
    listId: list.value.id,
    templateId: null,
    messageBody: "Olá {{firstName}}, novidades até {{date}}.",
    messageType: options.messageType ?? "TRANSACTIONAL",
    variables: { date: "31/10" },
  });
  if (!draft.ok) throw new Error(draft.message);
  return { campaignId: draft.value.id, listId: list.value.id, contactIds };
}

async function confirm(campaignId: string, extra: { confirmationText?: string; purposeAcknowledged?: boolean } = {}) {
  const preview = await buildCampaignPreview(campaignId);
  if (!preview) throw new Error("preview");
  return confirmCampaign(actors.operator, {
    campaignId,
    fingerprint: preview.fingerprint,
    confirmationText: extra.confirmationText ?? preview.requiredConfirmationText ?? "",
    purposeAcknowledged: extra.purposeAcknowledged ?? false,
  });
}

async function runUntilSettled(campaignId: string, deps: EngineDeps, advance: (ms: number) => void, max = 50) {
  let last: StepResult = { state: "continue", sent: 0 };
  for (let i = 0; i < max; i += 1) {
    last = await processCampaignStep(campaignId, deps);
    if (last.state === "done" || last.state === "paused") return last;
    if (last.state === "wait" || last.state === "busy") advance(last.waitMs + 1);
  }
  return last;
}

const messagesFor = (campaignId: string) =>
  prisma.smsMessage.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });

describe("campaign confirmation", () => {
  it("creates eligible and skipped recipients with §29 counts and audits who confirmed", async () => {
    const { campaignId } = await setup({ optedIn: 3, unknown: 1, optedOut: 1 });
    const preview = await buildCampaignPreview(campaignId);
    expect(preview?.plan.counts).toMatchObject({ total: 5, eligible: 3, noConsent: 1, optedOut: 1, invalidPhone: 0 });

    expect(await confirm(campaignId)).toEqual({ ok: true, value: { status: "confirmed" } });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign).toMatchObject({ status: "READY", mode: "TEST", provider: "fake", confirmedById: actors.operator.id });
    expect(await recipientCounts(campaignId)).toMatchObject({ PENDING: 3, SKIPPED: 2 });
    const skipped = await prisma.campaignRecipient.findMany({ where: { campaignId, status: "SKIPPED" } });
    expect(skipped.every((recipient) => recipient.renderedBody === null)).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "CAMPAIGN_CONFIRMED" } });
    expect(audit).toMatchObject({ userId: actors.operator.id, metadataJson: expect.objectContaining({ eligible: 3, mode: "TEST" }) });
  });

  it("is idempotent under double confirmation", async () => {
    const { campaignId } = await setup();
    const preview = await buildCampaignPreview(campaignId);
    const input = { campaignId, fingerprint: preview!.fingerprint, confirmationText: "", purposeAcknowledged: false };
    const results = await Promise.all([confirmCampaign(actors.operator, input), confirmCampaign(actors.operator, input)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ message: expect.stringMatching(/já foi confirmada/) });
    expect(await prisma.campaignRecipient.count({ where: { campaignId } })).toBe(3);
  });

  it("rejects a stale review (fingerprint) after the list changes", async () => {
    const { campaignId, contactIds } = await setup();
    const preview = await buildCampaignPreview(campaignId);
    await changeContactConsent(actors.operator, contactIds[0], "OPTED_OUT", {});
    const result = await confirmCampaign(actors.operator, {
      campaignId,
      fingerprint: preview!.fingerprint,
      confirmationText: "",
      purposeAcknowledged: false,
    });
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/mudaram desde a revisão/) });
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: "DRAFT" });
  });

  it("requires the exact second confirmation text above the threshold, checked on the server", async () => {
    process.env.SMS_BULK_CONFIRMATION_THRESHOLD = "2";
    const { campaignId } = await setup({ optedIn: 3 });
    expect((await buildCampaignPreview(campaignId))?.requiredConfirmationText).toBe("ENVIAR 3 SMS");
    expect(await confirm(campaignId, { confirmationText: "enviar" })).toMatchObject({ ok: false });
    expect(await confirm(campaignId, { confirmationText: "ENVIAR 2 SMS" })).toMatchObject({ ok: false });
    expect(await prisma.auditLog.count({ where: { action: "CAMPAIGN_CONFIRMATION_REJECTED" } })).toBe(2);
    expect(await confirm(campaignId, { confirmationText: "ENVIAR 3 SMS" })).toMatchObject({ ok: true });
  });

  it("requires the purpose acknowledgement for promotional campaigns", async () => {
    const { campaignId } = await setup({ messageType: "PROMOTIONAL" });
    expect((await buildCampaignPreview(campaignId))?.purposeBreakdown).toEqual([{ purpose: "marketing", count: 3 }]);
    expect(await confirm(campaignId)).toMatchObject({ ok: false, message: expect.stringMatching(/marketing/) });
    expect(await confirm(campaignId, { purposeAcknowledged: true })).toMatchObject({ ok: true });
  });

  it("denies VIEWER", async () => {
    const { campaignId } = await setup();
    const preview = await buildCampaignPreview(campaignId);
    expect(
      await confirmCampaign(actors.viewer, { campaignId, fingerprint: preview!.fingerprint, confirmationText: "", purposeAcknowledged: false }),
    ).toMatchObject({ ok: false });
    expect(await pauseCampaign(actors.viewer, campaignId)).toMatchObject({ ok: false });
  });
});

describe("campaign processing", () => {
  it("sends every eligible recipient exactly once and completes", async () => {
    const { campaignId } = await setup({ optedIn: 3, unknown: 1 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);

    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[0].messageBody).toBe("Olá Cliente1, novidades até 31/10.");
    const messages = await messagesFor(campaignId);
    expect(messages).toHaveLength(3);
    expect(messages.every((m) => m.status === "ACCEPTED" && m.dryRun && m.createdById === actors.operator.id)).toBe(true);
    const recipients = await prisma.campaignRecipient.findMany({ where: { campaignId, status: "ACCEPTED" } });
    expect(recipients.every((r) => r.renderedBody === null && r.messageId)).toBe(true);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.finishedAt).toBeInstanceOf(Date);
    expect(await prisma.auditLog.count({ where: { action: "CAMPAIGN_FINISHED" } })).toBe(1);
  });

  it("never sends twice with concurrent steps", async () => {
    const { campaignId } = await setup({ optedIn: 6 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps } = engine(provider, {
      limits: { maxRecipients: 500, maxSendsPerMinute: 1000, batchSize: 2, bulkConfirmationThreshold: 50, maxAttempts: 3 },
    });
    for (let round = 0; round < 6; round += 1) {
      await Promise.all([processCampaignStep(campaignId, deps), processCampaignStep(campaignId, deps), processCampaignStep(campaignId, deps)]);
    }
    const phones = provider.calls.map((call) => call.destinationPhoneNumber);
    expect(new Set(phones).size).toBe(phones.length);
    expect(phones).toHaveLength(6);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: "COMPLETED" });
  });

  it("respects the global per-minute limit (including manual sends)", async () => {
    const { campaignId } = await setup({ optedIn: 3 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps } = engine(provider, {
      limits: { maxRecipients: 500, maxSendsPerMinute: 2, batchSize: 10, bulkConfirmationThreshold: 50, maxAttempts: 3 },
    });
    const step = await processCampaignStep(campaignId, deps);
    expect(step).toMatchObject({ state: "wait", reason: expect.stringMatching(/por minuto/) });
    expect(provider.calls).toHaveLength(2);
    expect(await checkPerMinute(2)).toMatchObject({ ok: false });
  });

  it("respects parts per second (MPS) per country: waits without sleep, paces within the step with sleep", async () => {
    const { campaignId } = await setup({ optedIn: 3 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const slow = { originMps: 100, countryMps: { PT: 1 }, defaultCountryMps: 1, burstSeconds: 1 };
    const { deps } = engine(provider, { rate: slow });
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({
      state: "wait",
      reason: expect.stringMatching(/partes SMS por segundo \(país PT\)/),
    });
    expect(provider.calls).toHaveLength(1);

    // Com sleep: esperas curtas de MPS são feitas dentro do passo (o relógio avança).
    const paced = engine(provider, { rate: slow });
    const sleeps: number[] = [];
    paced.deps.sleep = async (ms) => {
      sleeps.push(ms);
      paced.advance(ms);
    };
    paced.advance(1_000);
    await processCampaignStep(campaignId, paced.deps);
    expect(provider.calls).toHaveLength(3);
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps.every((ms) => ms <= 1_000)).toBe(true);
    expect(new Set(provider.calls.map((c) => c.context?.internalMessageId)).size).toBe(3);
  });

  it("feeds AWS throttling back into the MPS buckets", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    await processCampaignStep(campaignId, engine(new RecordingProvider("throttle")).deps);
    const buckets = await prisma.sendRateBucket.findMany();
    expect(buckets).toHaveLength(2);
    expect(buckets.every((b) => b.rateFactor === 0.5 && b.throttledAt !== null)).toBe(true);
  });

  it("retries throttling with backoff and a new attempt key, then pauses (never mass-fails) after max attempts", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const provider = new RecordingProvider("throttle");
    const { deps, advance } = engine(provider, {
      limits: { maxRecipients: 500, maxSendsPerMinute: 1000, batchSize: 10, bulkConfirmationThreshold: 50, maxAttempts: 2 },
    });

    const first = await processCampaignStep(campaignId, deps);
    expect(first).toMatchObject({ state: "wait" });
    const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId, status: "PENDING" } });
    expect(recipient).toMatchObject({ attempt: 2, retries: 1, errorCode: "THROTTLED" });
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "wait" });
    expect(provider.calls).toHaveLength(1);

    advance(60_000);
    expect(await runUntilSettled(campaignId, deps, advance)).toMatchObject({
      state: "paused",
      reason: expect.stringMatching(/continua a limitar/),
    });
    expect(provider.calls).toHaveLength(2);
    const keys = (await messagesFor(campaignId)).map((m) => m.idempotencyKey);
    expect(keys).toEqual([idempotencyKeyFor(campaignId, recipient.id, 1), idempotencyKeyFor(campaignId, recipient.id, 2)]);
    // O destinatário continua por enviar (nunca foi enviado) e a retoma dá-lhe nova oportunidade.
    expect(await recipientCounts(campaignId)).toMatchObject({ PENDING: 1, FAILED: 0 });
    provider.scenario = "success";
    await resumeCampaign(actors.operator, campaignId);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    expect(provider.calls).toHaveLength(3);
  });

  it("never retries uncertain results and halts after consecutive unknowns", async () => {
    const { campaignId } = await setup({ optedIn: 4 });
    await confirm(campaignId);
    const provider = new RecordingProvider("uncertain");
    const { deps, advance } = engine(provider);
    const result = await runUntilSettled(campaignId, deps, advance);
    expect(result).toMatchObject({ state: "paused", reason: expect.stringMatching(/incertos seguidos/) });
    expect(provider.calls).toHaveLength(3);
    expect(await recipientCounts(campaignId)).toMatchObject({ UNKNOWN: 3, PENDING: 1 });
    expect(await prisma.auditLog.count({ where: { action: "CAMPAIGN_HALTED" } })).toBe(1);
  });

  it("halts on account-level errors without burning recipients, and resumes explicitly", async () => {
    const { campaignId } = await setup({ optedIn: 3 });
    await confirm(campaignId);
    const provider = new RecordingProvider("spend_limit");
    const { deps, advance } = engine(provider);

    expect(await runUntilSettled(campaignId, deps, advance)).toMatchObject({
      state: "paused",
      reason: expect.stringMatching(/limite de gastos/),
    });
    expect(provider.calls).toHaveLength(1);
    expect(await recipientCounts(campaignId)).toMatchObject({ PENDING: 3, FAILED: 0 });

    provider.scenario = "success";
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "paused" });
    expect(await resumeCampaign(actors.admin, campaignId)).toMatchObject({ ok: true });
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    expect(provider.calls).toHaveLength(4);
    expect(await prisma.auditLog.findFirst({ where: { action: "CAMPAIGN_RESUMED", userId: actors.admin.id } })).not.toBeNull();
  });

  it("re-checks opt-out immediately before sending", async () => {
    const { campaignId, contactIds } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    await changeContactConsent(actors.operator, contactIds[1], "OPTED_OUT", { source: "STOP" });
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    expect(provider.calls).toHaveLength(1);
    const skipped = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId, contactId: contactIds[1] } });
    expect(skipped).toMatchObject({ status: "SKIPPED", skipReason: "OPTED_OUT", renderedBody: null });
  });

  it("recovers stale in-flight recipients safely", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    const [a, b] = await prisma.campaignRecipient.findMany({ where: { campaignId }, orderBy: { createdAt: "asc" } });
    const old = new Date(Date.now() - STALE_MS - 60_000);
    // a: reservado mas o provider nunca foi chamado → volta a PENDING e é enviado uma vez.
    await prisma.campaignRecipient.update({ where: { id: a.id }, data: { status: "PROCESSING", claimToken: "dead", claimedAt: old } });
    // b: o processo morreu depois de criar o SmsMessage → incerto, nunca reenviado.
    await prisma.campaignRecipient.update({ where: { id: b.id }, data: { status: "PROCESSING", claimToken: "dead2", claimedAt: old } });
    await prisma.smsMessage.create({
      data: {
        idempotencyKey: idempotencyKeyFor(campaignId, b.id, 1),
        campaignId,
        destinationPhoneE164: "+351911000002",
        messageType: "TRANSACTIONAL",
        body: "x",
        provider: "fake",
        dryRun: true,
        createdById: actors.operator.id,
        createdAt: old,
      },
    });
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "SENDING", startedAt: old } });

    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "PARTIAL" });
    expect(provider.calls).toHaveLength(1);
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ status: "UNKNOWN" });
    expect(await prisma.smsMessage.findUniqueOrThrow({ where: { idempotencyKey: idempotencyKeyFor(campaignId, b.id, 1) } })).toMatchObject({
      status: "UNKNOWN",
    });
  });

  it("never calls the provider when the attempt key was already used", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    await prisma.smsMessage.create({
      data: {
        idempotencyKey: idempotencyKeyFor(campaignId, recipient.id, 1),
        campaignId,
        destinationPhoneE164: "+351911000001",
        messageType: "TRANSACTIONAL",
        body: "x",
        provider: "fake",
        dryRun: true,
        status: "ACCEPTED",
        createdById: actors.operator.id,
      },
    });
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    expect(provider.calls).toHaveLength(0);
  });

  it("cancels mid-campaign: pending recipients are never sent", async () => {
    const { campaignId } = await setup({ optedIn: 4 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps } = engine(provider, {
      limits: { maxRecipients: 500, maxSendsPerMinute: 1000, batchSize: 1, bulkConfirmationThreshold: 50, maxAttempts: 3 },
    });
    await processCampaignStep(campaignId, deps);
    expect(await cancelCampaign(actors.operator, campaignId)).toMatchObject({ ok: true });
    expect(await processCampaignStep(campaignId, deps)).toEqual({ state: "done", status: "CANCELLED" });
    expect(provider.calls).toHaveLength(1);
    expect(await recipientCounts(campaignId)).toMatchObject({ ACCEPTED: 1, CANCELLED: 3 });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).finishedAt).toBeInstanceOf(Date);
  });

  it("pause is persisted on the server and blocks every step until an explicit resume", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    expect(await pauseCampaign(actors.operator, campaignId)).toMatchObject({ ok: true });
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "paused" });
    expect(provider.calls).toHaveLength(0);
    await resumeCampaign(actors.operator, campaignId);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    const actions = (await prisma.auditLog.findMany({ where: { entityId: campaignId } })).map((log) => log.action);
    expect(actions).toEqual(expect.arrayContaining(["CAMPAIGN_PAUSED", "CAMPAIGN_STARTED", "CAMPAIGN_FINISHED"]));
  });

  it("stops if the mode or origin changes after confirmation (no silent real send)", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps } = engine(provider, {
      origin: () =>
        currentOrigin({ SMS_PROVIDER: "aws", AWS_SMS_DRY_RUN: "false", AWS_SMS_ORIGINATION_IDENTITY: "CAETANO" }),
    });
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "paused", reason: expect.stringMatching(/modo mudou/) });
    expect(provider.calls).toHaveLength(0);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ lastError: expect.any(String) });
  });

  it("expires a confirmation that was never started and allows reverting to draft", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    await prisma.campaign.update({ where: { id: campaignId }, data: { confirmedAt: new Date(Date.now() - 25 * 3600_000) } });
    const provider = new RecordingProvider();
    const { deps } = engine(provider);
    // Expirada: volta a rascunho automaticamente e o texto congelado (com nomes) é apagado.
    expect(await processCampaignStep(campaignId, deps)).toEqual({ state: "done", status: "DRAFT" });
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: "DRAFT", confirmedAt: null });
    expect(await prisma.campaignRecipient.count({ where: { campaignId } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "CAMPAIGN_CONFIRMATION_EXPIRED" } })).toBe(1);
    expect(provider.calls).toHaveLength(0);
    // Revert manual também funciona enquanto nada foi tentado.
    await confirm(campaignId);
    expect(await revertCampaignToDraft(actors.operator, campaignId)).toMatchObject({ ok: true });
  });

  it("cancels pending sends and removes rendered text when a contact is deleted", async () => {
    const { campaignId, contactIds } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    expect(await deleteContact(actors.admin, contactIds[0])).toMatchObject({ ok: true });
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    expect(provider.calls).toHaveLength(1);
    const orphan = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId, contactId: null } });
    expect(orphan).toMatchObject({ status: "SKIPPED", skipReason: "CONTACT_DELETED", renderedBody: null });
  });
});

describe("campaign safety edge cases", () => {
  it("a stalled worker that resumes after recovery never causes a second send", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    // Worker A: reserva o destinatário e "congela" antes de criar o SmsMessage.
    const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    const old = new Date(Date.now() - STALE_MS - 1_000);
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "SENDING", startedAt: old } });
    await prisma.campaignRecipient.update({
      where: { id: recipient.id },
      data: { status: "PROCESSING", claimToken: "worker-a", claimedAt: old },
    });

    // Um novo passo recupera (mesma tentativa → mesma chave) e envia.
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });

    // Worker A acorda e tenta continuar com o seu job antigo: perdeu a posse, nada é enviado.
    const { sendCampaignRecipient } = await import("@/server/services/campaigns/engine");
    await sendCampaignRecipient({ campaignId, recipientId: recipient.id, claimToken: "worker-a" }, deps);
    // Mesmo que forçasse o dispatch, a chave da tentativa já foi usada.
    expect(provider.calls).toHaveLength(1);
    expect(await prisma.smsMessage.count({ where: { campaignId } })).toBe(1);
  });

  it("a step never releases a lease owned by another step", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { processingLeaseToken: "other", processingLeaseUntil: new Date(Date.now() + 60_000) },
    });
    const provider = new RecordingProvider();
    const { deps } = engine(provider);
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "busy" });
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({
      processingLeaseToken: "other",
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects draft edits after confirmation", async () => {
    const { campaignId, listId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const { updateCampaignDraft } = await import("@/server/services/campaign-drafts");
    expect(
      await updateCampaignDraft(actors.operator, campaignId, {
        name: "Alterada",
        listId,
        templateId: null,
        messageBody: "Outro texto",
        messageType: "TRANSACTIONAL",
        variables: {},
      }),
    ).toMatchObject({ ok: false });
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ name: "Outubro" });
  });

  it("stale claims do not consume the global rate budget", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    const [a] = await prisma.campaignRecipient.findMany({ where: { campaignId } });
    await prisma.campaignRecipient.update({
      where: { id: a.id },
      data: { status: "PROCESSING", claimToken: "dead", claimedAt: new Date(Date.now() - 120_000) },
    });
    expect(await checkPerMinute(1)).toEqual({ ok: true });
  });

  it("campaign messages are linked to the campaign and to the confirming operator", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    await runUntilSettled(campaignId, deps, advance);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { messages: true } });
    expect(campaign.messages).toHaveLength(2);
    expect(provider.calls.every((call) => call.context?.campaignId === campaignId)).toBe(true);
  });

  it("reverting to draft is only possible while nothing was attempted", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps } = engine(provider, {
      limits: { maxRecipients: 500, maxSendsPerMinute: 1000, batchSize: 1, bulkConfirmationThreshold: 50, maxAttempts: 3 },
    });
    await processCampaignStep(campaignId, deps);
    await pauseCampaign(actors.operator, campaignId);
    expect(await revertCampaignToDraft(actors.operator, campaignId)).toMatchObject({ ok: false });
  });
});

describe("review regressions", () => {
  it("confirming again never reports success nor clears a halt", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    const provider = new RecordingProvider("auth");
    const { deps, advance } = engine(provider);
    expect(await runUntilSettled(campaignId, deps, advance)).toMatchObject({ state: "paused" });
    const again = await confirmCampaign(actors.operator, {
      campaignId,
      fingerprint: "x",
      confirmationText: "",
      purposeAcknowledged: false,
    });
    expect(again).toMatchObject({ ok: false, message: expect.stringMatching(/já foi confirmada/) });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).pausedAt).toBeInstanceOf(Date);
  });

  it("a send in flight during cancellation never returns the recipient to PENDING", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    // Provider que cancela a campanha a meio do pedido e responde com throttling.
    const provider = new RecordingProvider("throttle");
    const original = provider.send.bind(provider);
    provider.send = async (input) => {
      await cancelCampaign(actors.operator, campaignId);
      return original(input);
    };
    const { deps } = engine(provider);
    await processCampaignStep(campaignId, deps);
    expect(await recipientCounts(campaignId)).toMatchObject({ PENDING: 0, PROCESSING: 0, CANCELLED: 1 });
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign).toMatchObject({ status: "CANCELLED" });
    expect(campaign.finishedAt).toBeInstanceOf(Date);
  });

  it("reconciles stale sends of a cancelled campaign (message becomes UNKNOWN)", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    const old = new Date(Date.now() - STALE_MS - 1_000);
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "SENDING", startedAt: old } });
    await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "PROCESSING", claimToken: "dead", claimedAt: old } });
    await prisma.smsMessage.create({
      data: {
        idempotencyKey: idempotencyKeyFor(campaignId, recipient.id, 1),
        campaignId,
        destinationPhoneE164: "+351911000001",
        messageType: "TRANSACTIONAL",
        body: "x",
        provider: "fake",
        dryRun: true,
        createdById: actors.operator.id,
        createdAt: old,
      },
    });
    await cancelCampaign(actors.operator, campaignId);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).finishedAt).toBeNull();

    const { reconcileCampaign } = await import("@/server/services/campaigns/engine");
    await reconcileCampaign(campaignId, { now: () => new Date(), logger: { log: () => {} } });
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).toMatchObject({ status: "UNKNOWN" });
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).finishedAt).toBeInstanceOf(Date);
  });

  it("recovery of a throttled send retries it with a new key instead of failing it", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const recipient = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId } });
    const old = new Date(Date.now() - STALE_MS - 1_000);
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "SENDING", startedAt: old } });
    await prisma.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "PROCESSING", claimToken: "dead", claimedAt: old } });
    await prisma.smsMessage.create({
      data: {
        idempotencyKey: idempotencyKeyFor(campaignId, recipient.id, 1),
        campaignId,
        destinationPhoneE164: "+351911000001",
        messageType: "TRANSACTIONAL",
        body: "x",
        provider: "fake",
        dryRun: true,
        status: "FAILED",
        errorCode: "THROTTLED",
        createdById: actors.operator.id,
        createdAt: old,
      },
    });
    const provider = new RecordingProvider();
    const { deps, advance } = engine(provider);
    expect(await runUntilSettled(campaignId, deps, advance)).toEqual({ state: "done", status: "COMPLETED" });
    expect(provider.calls).toHaveLength(1);
    expect(await prisma.campaignRecipient.findUniqueOrThrow({ where: { id: recipient.id } })).toMatchObject({ attempt: 2, status: "ACCEPTED" });
  });

  it("deleting a contact removes its phone hash from campaign recipients", async () => {
    const { campaignId, contactIds } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    expect((await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).phoneHash).toMatch(/^[0-9a-f]{64}$/);
    await deleteContact(actors.admin, contactIds[0]);
    expect(await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId } })).toMatchObject({
      contactId: null,
      phoneHash: null,
      renderedBody: null,
    });
  });
});

describe("campaign worker", () => {
  it("only advances campaigns an operator already started and never starts READY ones", async () => {
    const { runWorkerOnce } = await import("@/server/services/campaigns/worker");
    const started = await setup({ optedIn: 2 });
    await confirm(started.campaignId);
    const notStarted = await (async () => {
      const list = await createList(actors.operator, { name: "Outra" });
      if (!list.ok) throw new Error("list");
      const c = await createContact(actors.operator, { name: "Zé Lopes", phone: "919999999", consentStatus: "OPTED_IN", consent: optIn });
      if (!c.ok) throw new Error("contact");
      await addContactToList(actors.operator, list.value.id, c.value.id);
      const draft = await createCampaignDraft(actors.operator, {
        name: "Parada", listId: list.value.id, templateId: null, messageBody: "Olá", messageType: "TRANSACTIONAL", variables: {},
      });
      if (!draft.ok) throw new Error("draft");
      await confirm(draft.value.id);
      return draft.value.id;
    })();
    // O operador iniciou a primeira (1 passo com lote de 1) e depois fechou a página.
    const provider = new RecordingProvider();
    const { deps } = engine(provider, {
      limits: { maxRecipients: 500, maxSendsPerMinute: 1000, batchSize: 1, bulkConfirmationThreshold: 50, maxAttempts: 3 },
    });
    await processCampaignStep(started.campaignId, deps);

    for (let i = 0; i < 5; i += 1) await runWorkerOnce(deps);
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: started.campaignId } })).toMatchObject({ status: "COMPLETED" });
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: notStarted } })).toMatchObject({ status: "READY" });
    expect(provider.calls).toHaveLength(2);
  });

  it("skips paused campaigns", async () => {
    const { runWorkerOnce } = await import("@/server/services/campaigns/worker");
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "SENDING", startedAt: new Date() } });
    await pauseCampaign(actors.operator, campaignId);
    const provider = new RecordingProvider();
    const { deps } = engine(provider);
    await runWorkerOnce(deps);
    expect(provider.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fila SQS (cliente em memória: nunca contacta a AWS)
// ---------------------------------------------------------------------------

class MemorySqs {
  messages: { id: string; body: string; receiptHandle: string; receives: number }[] = [];
  deleted: string[] = [];
  failSend = false;
  private seq = 0;

  send(command: SendMessageCommand | ReceiveMessageCommand | DeleteMessageCommand): Promise<never>;
  async send(command: SendMessageCommand | ReceiveMessageCommand | DeleteMessageCommand) {
    if (command instanceof SendMessageCommand) {
      if (this.failSend) throw Object.assign(new Error("unavailable"), { name: "QueueUnavailable" });
      this.seq += 1;
      this.messages.push({ id: `m${this.seq}`, body: command.input.MessageBody ?? "", receiptHandle: `rh${this.seq}`, receives: 0 });
      return { $metadata: {} };
    }
    if (command instanceof ReceiveMessageCommand) {
      const batch = this.messages.slice(0, command.input.MaxNumberOfMessages ?? 1);
      for (const m of batch) m.receives += 1;
      return {
        $metadata: {},
        Messages: batch.map((m) => ({ MessageId: m.id, Body: m.body, ReceiptHandle: m.receiptHandle, Attributes: { ApproximateReceiveCount: String(m.receives) } })),
      };
    }
    this.deleted.push(command.input.ReceiptHandle ?? "");
    this.messages = this.messages.filter((m) => m.receiptHandle !== command.input.ReceiptHandle);
    return { $metadata: {} };
  }
}

const SQS_CONFIG = {
  kind: "sqs",
  region: "eu-west-1",
  queueUrl: "https://sqs.eu-west-1.amazonaws.com/123456789012/sms-jobs",
  fifo: false,
  maxInFlight: 2,
  visibilityTimeoutSeconds: 60,
} as const;

describe("SQS job queue + worker", () => {
  function sqsEngine(provider: RecordingProvider, sqs = new MemorySqs()) {
    const { deps, advance } = engine(provider, { queue: new SqsSmsJobQueue(SQS_CONFIG, sqs) });
    const poll = (engineDeps: EngineDeps = deps) =>
      pollSmsJobsOnce({ client: sqs as unknown as SqsConsumerClient, config: SQS_CONFIG, engine: engineDeps, waitTimeSeconds: 0 });
    return { deps, advance, sqs, poll };
  }

  it("publishes claimed recipients (bounded in-flight) and the worker sends and completes the campaign", async () => {
    const { campaignId } = await setup({ optedIn: 3 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps, sqs, poll } = sqsEngine(provider);

    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "wait", reason: "A aguardar a fila de envio." });
    expect(provider.calls).toHaveLength(0); // o passo só publica
    expect(sqs.messages).toHaveLength(2);
    expect(sqs.messages[0].body).not.toMatch(/\+351|Cliente|Olá/);
    expect((await recipientCounts(campaignId)).PROCESSING).toBe(2);

    expect(await poll()).toEqual({ received: 2, processed: 2, discarded: 0, failed: 0 });
    expect(provider.calls).toHaveLength(2);
    expect(sqs.messages).toHaveLength(0);

    await processCampaignStep(campaignId, deps);
    await poll();
    expect(provider.calls).toHaveLength(3);
    // O worker finaliza a campanha quando termina o último destinatário.
    expect(await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).toMatchObject({ status: "COMPLETED" });
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "done", status: "COMPLETED" });
  });

  it("redelivered or late messages never send twice", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps, sqs, poll } = sqsEngine(provider);
    await processCampaignStep(campaignId, deps);
    const copy = { ...sqs.messages[0] };
    await poll();
    // SQS pode entregar a mesma mensagem outra vez (at-least-once).
    sqs.messages.push({ ...copy, receiptHandle: "rh-again" });
    expect(await poll()).toMatchObject({ processed: 1 });
    expect(provider.calls).toHaveLength(1);
    expect(await prisma.smsMessage.count({ where: { campaignId } })).toBe(1);
  });

  it("a worker with a different mode/origin pauses the campaign instead of sending", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps, poll } = sqsEngine(provider);
    await processCampaignStep(campaignId, deps);

    const production = currentOrigin({ SMS_PROVIDER: "aws", AWS_SMS_DRY_RUN: "false", AWS_SMS_ORIGINATION_IDENTITY: "Caetano" });
    expect(await poll({ ...deps, origin: () => production })).toMatchObject({ processed: 1 });
    expect(provider.calls).toHaveLength(0);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(campaign.pausedAt).not.toBeNull();
    expect(campaign.lastError).toMatch(/modo mudou/);
    expect((await recipientCounts(campaignId)).PENDING).toBe(1);
  });

  it("jobs already queued wait during a throttling backoff instead of sending", async () => {
    const { campaignId } = await setup({ optedIn: 2 });
    await confirm(campaignId);
    const provider = new RecordingProvider("throttle");
    const { deps, poll } = sqsEngine(provider);
    await processCampaignStep(campaignId, deps);
    await poll();
    // O primeiro job é limitado pela AWS; o segundo já não é enviado durante o backoff.
    expect(provider.calls).toHaveLength(1);
    expect((await recipientCounts(campaignId)).PENDING).toBe(2);
    const second = await prisma.campaignRecipient.findFirstOrThrow({ where: { campaignId, retries: 0 } });
    expect(second).toMatchObject({ attempt: 1, claimToken: null });
  });

  it("releases the claim when publishing fails", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const sqs = new MemorySqs();
    sqs.failSend = true;
    const { deps } = sqsEngine(new RecordingProvider(), sqs);
    expect(await processCampaignStep(campaignId, deps)).toMatchObject({ state: "wait", reason: expect.stringMatching(/indisponível/) });
    const [recipient] = await prisma.campaignRecipient.findMany({ where: { campaignId } });
    expect(recipient).toMatchObject({ status: "PENDING", claimToken: null, attempt: 1 });
  });

  it("discards invalid messages and keeps failed ones for redelivery", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps, sqs, poll } = sqsEngine(provider);
    await processCampaignStep(campaignId, deps);
    sqs.messages.push({ id: "bad", body: "{\"v\":1}", receiptHandle: "rh-bad", receives: 0 });

    const broken = {
      ...deps,
      origin: () => {
        throw new Error("config");
      },
    };
    expect(await poll(broken)).toEqual({ received: 2, processed: 0, discarded: 1, failed: 1 });
    expect(sqs.deleted).toEqual(["rh-bad"]);
    expect(sqs.messages).toHaveLength(1); // volta a ficar visível

    expect(await poll()).toMatchObject({ processed: 1 });
    expect(provider.calls).toHaveLength(1);
  });

  it("lost messages are recovered by reconciliation and re-published with the same attempt key", async () => {
    const { campaignId } = await setup({ optedIn: 1 });
    await confirm(campaignId);
    const provider = new RecordingProvider();
    const { deps, advance, sqs, poll } = sqsEngine(provider);
    await processCampaignStep(campaignId, deps);
    const lost = sqs.messages.splice(0, 1)[0];

    advance(STALE_MS + 1_000);
    await processCampaignStep(campaignId, deps); // reconcilia e volta a publicar
    expect(sqs.messages).toHaveLength(1);
    expect(sqs.messages[0].body).not.toBe(lost.body); // novo claimToken
    await poll();
    // A mensagem perdida reaparece: token antigo, não faz nada.
    sqs.messages.push(lost);
    await poll();
    expect(provider.calls).toHaveLength(1);
    const [recipient] = await prisma.campaignRecipient.findMany({ where: { campaignId } });
    expect(recipient).toMatchObject({ status: "ACCEPTED", attempt: 1 });
  });
});
