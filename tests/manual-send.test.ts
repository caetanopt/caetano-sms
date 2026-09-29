import { describe, expect, it } from "vitest";
import { createMemoryLogger } from "../src/lib/logging/logger";
import { getSmsRuntimeConfig } from "../src/lib/sms/config";
import { FakeSmsProvider, type FakeScenario } from "../src/lib/sms/fake-provider";
import type { SendSmsInput, SmsProvider } from "../src/lib/sms/types";
import {
  executeManualSend,
  prepareManualSend,
  type AuditEntry,
  type ManualSendDeps,
  type ManualSendInput,
  type ManualSendStore,
  type MessageOutcomeUpdate,
  type PendingMessageData,
  type StoredContact,
  type StoredTemplate,
} from "../src/server/services/manual-send";

type StoredMessage = PendingMessageData & {
  id: string;
  status: string;
  awsMessageId?: string;
  errorCode?: string;
  providerErrorName?: string;
  failedAt?: Date | null;
};

function createMemoryStore(
  contacts: StoredContact[] = [],
  suppressedPhones: string[] = [],
  templates: StoredTemplate[] = [],
) {
  const messages: StoredMessage[] = [];
  const suppressed = new Set(suppressedPhones);
  const audits: AuditEntry[] = [];
  const contactsByPhone = new Map<string, StoredContact>();
  const phones = ["+351912345678", "+351913456789", "+351914567890"];
  contacts.forEach((contact, index) => contactsByPhone.set(phones[index], contact));

  const store: ManualSendStore = {
    async findContactByPhone(phone) {
      return contactsByPhone.get(phone) ?? null;
    },
    async findTemplate(id) {
      return templates.find((template) => template.id === id) ?? null;
    },
    async isSuppressed(phone) {
      return suppressed.has(phone);
    },
    async findMessageByIdempotencyKey(key) {
      return messages.find((message) => message.idempotencyKey === key) ?? null;
    },
    async createPendingMessage(data) {
      if (messages.some((message) => message.idempotencyKey === data.idempotencyKey)) return null;
      const message = { ...data, id: `msg_${messages.length + 1}`, status: "PENDING" };
      messages.push(message);
      return { id: message.id };
    },
    async completeMessage(id, update, audit) {
      Object.assign(messages.find((message) => message.id === id)!, update satisfies MessageOutcomeUpdate);
      if (audit) audits.push(audit);
    },
    async recordProviderOptOut(phone, contactId, audit) {
      suppressed.add(phone);
      for (const contact of contactsByPhone.values()) {
        if (contact.id === contactId && contact.optedOutAt === null) {
          contact.optedOutAt = new Date();
          contact.consentStatus = "OPTED_OUT";
        }
      }
      audits.push(audit);
    },
    async writeAudit(entry) {
      audits.push(entry);
    },
  };
  return { store, messages, audits, suppressed };
}

class RecordingProvider implements SmsProvider {
  readonly calls: SendSmsInput[] = [];
  constructor(private readonly inner: SmsProvider = new FakeSmsProvider()) {}
  async send(input: SendSmsInput) {
    this.calls.push(input);
    return this.inner.send(input);
  }
}

function setup(
  options: {
    contacts?: StoredContact[];
    suppressed?: string[];
    templates?: StoredTemplate[];
    scenario?: FakeScenario;
    provider?: SmsProvider;
  } = {},
) {
  const memory = createMemoryStore(options.contacts, options.suppressed, options.templates);
  const provider = options.provider ?? new RecordingProvider(new FakeSmsProvider({ scenario: options.scenario }));
  const { logger, entries } = createMemoryLogger();
  const deps: ManualSendDeps = {
    store: memory.store,
    config: getSmsRuntimeConfig({ SMS_PROVIDER: "fake" }),
    getProvider: () => provider,
    logger,
  };
  return { ...memory, provider, deps, logs: entries };
}

let counter = 0;
function request(overrides: Partial<ManualSendInput> = {}): ManualSendInput {
  counter += 1;
  return {
    requestId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    phone: "912 345 678",
    message: "A sua encomenda foi expedida.",
    messageType: "TRANSACTIONAL",
    legalBasisConfirmed: false,
    userId: "user_1",
    ...overrides,
  };
}

const optedIn: StoredContact = { id: "c_in", name: "Maria", consentStatus: "OPTED_IN", optedOutAt: null };
const optedOut: StoredContact = { id: "c_out", name: "João", consentStatus: "OPTED_OUT", optedOutAt: new Date() };

describe("prepareManualSend", () => {
  it("returns a review summary with normalized number, contact and segments", async () => {
    const { deps } = setup({ contacts: [optedIn] });
    const result = await prepareManualSend(request({ messageType: "PROMOTIONAL" }), deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview).toMatchObject({
      phoneE164: "+351912345678",
      contact: { name: "Maria", consentStatus: "OPTED_IN" },
      messageType: "PROMOTIONAL",
      mode: "TEST",
      segments: { encoding: "GSM_7", segments: 1 },
    });
  });

  it("rejects invalid numbers and oversized messages", async () => {
    const { deps } = setup();
    expect(await prepareManualSend(request({ phone: "+351 123" }), deps)).toMatchObject({
      ok: false,
      reason: "INVALID_PHONE",
    });
    expect(await prepareManualSend(request({ message: "ã".repeat(631) }), deps)).toMatchObject({
      ok: false,
      reason: "INVALID_MESSAGE",
    });
    expect(await prepareManualSend(request({ message: "   " }), deps)).toMatchObject({
      ok: false,
      reason: "INVALID_MESSAGE",
    });
  });
});

describe("executeManualSend", () => {
  it("persists PENDING then ACCEPTED, in test mode, and audits", async () => {
    const { deps, messages, audits, provider } = setup();
    const outcome = await executeManualSend(request(), deps);

    expect(outcome).toMatchObject({ kind: "accepted", dryRun: true });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      status: "ACCEPTED",
      destinationPhoneE164: "+351912345678",
      provider: "fake",
      dryRun: true,
      encodingEstimate: "GSM_7",
      segmentCountEstimate: 1,
    });
    expect(messages[0].status).not.toBe("DELIVERED");
    expect(audits.map((audit) => audit.action)).toEqual(["SMS_SEND_ACCEPTED"]);
    expect((provider as RecordingProvider).calls[0]).toMatchObject({
      destinationPhoneNumber: "+351912345678",
      dryRun: true,
      context: { internalMessageId: messages[0].id, source: "manual" },
    });
  });

  it("is idempotent: the same requestId never sends twice", async () => {
    const { deps, messages, provider } = setup();
    const input = request();
    await executeManualSend(input, deps);
    const second = await executeManualSend(input, deps);

    expect(second).toMatchObject({ kind: "duplicate", status: "ACCEPTED" });
    expect(messages).toHaveLength(1);
    expect((provider as RecordingProvider).calls).toHaveLength(1);
  });

  it("handles a concurrent duplicate detected by the unique constraint", async () => {
    const { deps, provider } = setup();
    const input = request();
    const [a, b] = await Promise.all([executeManualSend(input, deps), executeManualSend(input, deps)]);
    expect([a.kind, b.kind].sort()).toEqual(["accepted", "duplicate"]);
    expect((provider as RecordingProvider).calls).toHaveLength(1);
  });

  it("blocks opted-out contacts before calling the provider and audits the attempt", async () => {
    const { deps, messages, audits, provider } = setup({ contacts: [optedOut] });
    const outcome = await executeManualSend(request(), deps);

    expect(outcome).toMatchObject({ kind: "rejected", reason: "OPTED_OUT" });
    expect(messages).toHaveLength(0);
    expect((provider as RecordingProvider).calls).toHaveLength(0);
    expect(audits[0]).toMatchObject({ action: "SMS_SEND_BLOCKED", metadata: { reason: "OPTED_OUT" } });
  });

  it("blocks promotional sends without consent", async () => {
    const unknown: StoredContact = { id: "c_unk", name: "Ana", consentStatus: "UNKNOWN", optedOutAt: null };
    const { deps, provider } = setup({ contacts: [unknown] });
    const outcome = await executeManualSend(
      request({ messageType: "PROMOTIONAL", legalBasisConfirmed: true }),
      deps,
    );
    expect(outcome).toMatchObject({ kind: "rejected", reason: "NO_CONSENT" });
    expect((provider as RecordingProvider).calls).toHaveLength(0);
  });

  it("records retryable throttling as FAILED with error details", async () => {
    const { deps, messages, audits } = setup({ scenario: "throttle" });
    const outcome = await executeManualSend(request(), deps);

    expect(outcome).toMatchObject({ kind: "failed", errorCode: "THROTTLED", retryable: true });
    expect(messages[0]).toMatchObject({
      status: "FAILED",
      errorCode: "THROTTLED",
      providerErrorName: "FakeThrottlingException",
    });
    expect(messages[0].failedAt).toBeInstanceOf(Date);
    expect(audits[0].action).toBe("SMS_SEND_FAILED");
  });

  it("records uncertain results as UNKNOWN, not FAILED", async () => {
    const { deps, messages, audits } = setup({ scenario: "uncertain" });
    const outcome = await executeManualSend(request(), deps);

    expect(outcome.kind).toBe("uncertain");
    expect(messages[0]).toMatchObject({ status: "UNKNOWN", failedAt: null });
    expect(audits[0].action).toBe("SMS_SEND_UNCERTAIN");
  });

  it("treats a throwing provider as uncertain and never leaves the message PENDING", async () => {
    const throwing: SmsProvider = {
      async send() {
        throw new Error("socket hang up");
      },
    };
    const { deps, messages } = setup({ provider: throwing });
    const outcome = await executeManualSend(request(), deps);

    expect(outcome.kind).toBe("uncertain");
    expect(messages[0].status).toBe("UNKNOWN");
  });

  it("does not create a message when the provider is misconfigured", async () => {
    const { deps, messages } = setup();
    const outcome = await executeManualSend(request(), {
      ...deps,
      getProvider: () => {
        throw new Error("AWS_REGION is required");
      },
    });

    expect(outcome.kind).toBe("configuration_error");
    expect(messages).toHaveLength(0);
  });

  it("adds the contact to the local suppression list when the provider reports opt-out", async () => {
    const contact = { ...optedIn };
    const { deps, audits } = setup({ contacts: [contact], scenario: "opt_out" });
    const outcome = await executeManualSend(request(), deps);

    expect(outcome).toMatchObject({ kind: "failed", errorCode: "OPTED_OUT", retryable: false });
    expect(contact.consentStatus).toBe("OPTED_OUT");
    expect(contact.optedOutAt).toBeInstanceOf(Date);
    expect(audits.map((audit) => audit.action)).toContain("CONTACT_OPTED_OUT_BY_PROVIDER");

    // Um envio seguinte é bloqueado localmente, sem chamar o provider.
    const next = await executeManualSend(request(), deps);
    expect(next).toMatchObject({ kind: "rejected", reason: "OPTED_OUT" });
  });

  it("blocks numbers in the suppression list even without a contact", async () => {
    const { deps, provider, messages } = setup({ suppressed: ["+351912345678"] });
    const outcome = await executeManualSend(request(), deps);
    expect(outcome).toMatchObject({ kind: "rejected", reason: "OPTED_OUT" });
    expect(messages).toHaveLength(0);
    expect((provider as RecordingProvider).calls).toHaveLength(0);
  });

  it("suppresses unknown numbers when the provider reports opt-out", async () => {
    const { deps, suppressed } = setup({ scenario: "opt_out" });
    await executeManualSend(request(), deps);
    expect(suppressed.has("+351912345678")).toBe(true);
  });

  describe("with templates", () => {
    const reminder: StoredTemplate = {
      id: "t1",
      name: "Lembrete",
      body: "Olá {{firstName}}, a sua marcação é dia {{date}} às {{time}}.",
      messageType: "TRANSACTIONAL",
    };
    const promo: StoredTemplate = { id: "t2", name: "Promo", body: "Promo {{place}}!", messageType: "PROMOTIONAL" };

    it("renders contact and manual variables and stores the final text and templateId", async () => {
      const { deps, messages, provider } = setup({ contacts: [optedIn], templates: [reminder] });
      const outcome = await executeManualSend(
        request({ templateId: "t1", message: "ignorado", variables: { date: "12/10", time: "14:30" } }),
        deps,
      );
      expect(outcome.kind).toBe("accepted");
      expect(messages[0]).toMatchObject({
        body: "Olá Maria, a sua marcação é dia 12/10 às 14:30.",
        templateId: "t1",
      });
      expect((provider as RecordingProvider).calls[0].messageBody).toBe("Olá Maria, a sua marcação é dia 12/10 às 14:30.");
    });

    it("uses the template body from the store, never the text sent by the browser", async () => {
      const { deps, messages } = setup({ contacts: [optedIn], templates: [reminder] });
      await executeManualSend(
        request({ templateId: "t1", message: "Texto alterado no browser", variables: { date: "1", time: "2" } }),
        deps,
      );
      expect(messages[0].body).not.toContain("alterado");
    });

    it("blocks and names the missing field, including contact variables for unknown numbers", async () => {
      const { deps, provider, messages } = setup({ templates: [reminder] });
      const outcome = await executeManualSend(request({ templateId: "t1", variables: { date: "12/10" } }), deps);
      expect(outcome).toMatchObject({ kind: "rejected", reason: "TEMPLATE_VARIABLES" });
      if (outcome.kind === "rejected") {
        expect(outcome.message).toContain("{{firstName}} (Primeiro nome)");
        expect(outcome.message).toContain("{{time}} (Hora)");
        expect(outcome.message).toMatch(/não corresponde a um contacto/);
      }
      expect(messages).toHaveLength(0);
      expect((provider as RecordingProvider).calls).toHaveLength(0);
    });

    it("never lets the browser override contact variables", async () => {
      const { deps, messages } = setup({ contacts: [optedIn], templates: [reminder] });
      await executeManualSend(
        request({ templateId: "t1", variables: { firstName: "Hacker", date: "1", time: "2" } as never }),
        deps,
      );
      expect(messages[0].body).toContain("Olá Maria");
    });

    it("rejects a message type different from the template and audits it", async () => {
      const { deps, audits } = setup({ contacts: [optedIn], templates: [promo] });
      const outcome = await executeManualSend(
        request({ templateId: "t2", messageType: "TRANSACTIONAL", variables: { place: "Lisboa" } }),
        deps,
      );
      expect(outcome).toMatchObject({ kind: "rejected", reason: "TEMPLATE_TYPE_MISMATCH" });
      expect(audits[0]).toMatchObject({ action: "SMS_SEND_BLOCKED", metadata: { reason: "TEMPLATE_TYPE_MISMATCH" } });
    });

    it("still applies consent rules to templated promotional messages", async () => {
      const unknown: StoredContact = { id: "c_unk", name: "Ana", consentStatus: "UNKNOWN", optedOutAt: null };
      const { deps } = setup({ contacts: [unknown], templates: [promo] });
      const outcome = await executeManualSend(
        request({ templateId: "t2", messageType: "PROMOTIONAL", variables: { place: "Lisboa" } }),
        deps,
      );
      expect(outcome).toMatchObject({ kind: "rejected", reason: "NO_CONSENT" });
    });

    it("rejects unknown templates", async () => {
      const { deps } = setup();
      expect(await executeManualSend(request({ templateId: "missing" }), deps)).toMatchObject({
        kind: "rejected",
        reason: "TEMPLATE_NOT_FOUND",
      });
    });

    it("renders placeholders in free text too and blocks unknown ones", async () => {
      const { deps, messages } = setup({ contacts: [optedIn] });
      expect(await executeManualSend(request({ message: "Olá {{nome}}" }), deps)).toMatchObject({
        kind: "rejected",
        reason: "TEMPLATE_VARIABLES",
      });
      await executeManualSend(request({ message: "Olá {{firstName}}" }), deps);
      expect(messages[0].body).toBe("Olá Maria");
    });

    it("computes segments on the rendered text", async () => {
      const long: StoredTemplate = { id: "t3", name: "Longo", body: "A".repeat(150) + " {{place}}", messageType: "TRANSACTIONAL" };
      const { deps } = setup({ templates: [long] });
      const prepared = await prepareManualSend(request({ templateId: "t3", variables: { place: "Loja de Lisboa" } }), deps);
      expect(prepared).toMatchObject({ ok: true, preview: { segments: { segments: 2 } } });
    });
  });

  it("respects the global rate limit before creating the message", async () => {
    const { deps, messages, provider } = setup();
    const outcome = await executeManualSend(request(), {
      ...deps,
      checkRate: async () => ({ ok: false, retryAfterMs: 12_000 }),
    });
    expect(outcome).toMatchObject({ kind: "rate_limited", message: expect.stringMatching(/12 s/) });
    expect(messages).toHaveLength(0);
    expect((provider as RecordingProvider).calls).toHaveLength(0);
  });

  it("never logs or audits the full phone number or message body", async () => {
    const { deps, logs, audits } = setup();
    const secretBody = "Código secreto 987654";
    await executeManualSend(request({ message: secretBody }), deps);
    await executeManualSend(request({ message: secretBody, phone: "+351 123" }), deps);

    const serialized = JSON.stringify({ logs, audits });
    expect(serialized).not.toContain("+351912345678");
    expect(serialized).not.toContain("912345678");
    expect(serialized).not.toContain(secretBody);
    expect(serialized).toContain("+351******678");
    expect(logs.find((entry) => entry.event === "sms.send.accepted")?.fields).toMatchObject({
      status: "ACCEPTED",
      dryRun: true,
      provider: "fake",
    });
  });
});
