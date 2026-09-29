import { describe, expect, it } from "vitest";
import { getCampaignLimits } from "../src/features/campaigns/limits";
import { classifyMember, planCampaign, type CampaignMember } from "../src/features/campaigns/plan";

const member = (overrides: Partial<CampaignMember> = {}): CampaignMember => ({
  contactId: "c1",
  name: "Maria Silva",
  phoneE164: "+351912345678",
  consentStatus: "OPTED_IN",
  optedOutAt: null,
  suppressed: false,
  ...overrides,
});

const limits = { maxRecipients: 500 };

describe("classifyMember", () => {
  it("requires opt-in for campaigns regardless of message type", () => {
    expect(classifyMember(member())).toBeNull();
    expect(classifyMember(member({ consentStatus: "UNKNOWN" }))).toBe("NO_CONSENT");
  });

  it("treats opt-out, optedOutAt and suppression as opted out", () => {
    expect(classifyMember(member({ consentStatus: "OPTED_OUT" }))).toBe("OPTED_OUT");
    expect(classifyMember(member({ optedOutAt: new Date() }))).toBe("OPTED_OUT");
    expect(classifyMember(member({ suppressed: true }))).toBe("OPTED_OUT");
  });

  it("re-validates stored numbers", () => {
    expect(classifyMember(member({ phoneE164: "+35112" }))).toBe("INVALID_PHONE");
  });
});

describe("planCampaign", () => {
  it("counts every category of §29 and estimates total segments", () => {
    const plan = planCampaign({
      body: "Olá {{firstName}}, promoção até {{date}}.",
      manualValues: { date: "31/10" },
      limits,
      members: [
        member({ contactId: "a" }),
        member({ contactId: "b", name: "Rui Costa" }),
        member({ contactId: "c", consentStatus: "UNKNOWN" }),
        member({ contactId: "d", suppressed: true }),
        member({ contactId: "e", phoneE164: "+35112" }),
      ],
    });
    expect(plan.counts).toEqual({
      total: 5,
      eligible: 2,
      optedOut: 1,
      noConsent: 1,
      invalidPhone: 1,
      totalSegments: 2,
      segmentsByCountry: { PT: 2 },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.recipients.find((r) => r.contactId === "b")).toMatchObject({
      eligible: true,
      renderedBody: "Olá Rui, promoção até 31/10.",
    });
  });

  it("blocks and lists contacts with missing variables", () => {
    const plan = planCampaign({
      body: "Olá {{firstName}} {{lastName}}",
      manualValues: {},
      limits,
      members: [member({ contactId: "a" }), member({ contactId: "b", name: "Rui" })],
    });
    expect(plan.missingVariables).toEqual([{ contactId: "b", contactName: "Rui", missing: ["lastName"] }]);
    expect(plan.blockers.join()).toMatch(/variáveis em falta/);
  });

  it("does not require variables for excluded contacts", () => {
    const plan = planCampaign({
      body: "Olá {{lastName}}",
      manualValues: {},
      limits,
      members: [member({ contactId: "a" }), member({ contactId: "b", name: "Rui", consentStatus: "UNKNOWN" })],
    });
    expect(plan.missingVariables).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it("blocks invalid templates, empty eligibility and the recipient limit", () => {
    expect(planCampaign({ body: "Olá {{nome}}", manualValues: {}, limits, members: [member()] }).blockers.join()).toMatch(
      /desconhecida/,
    );
    expect(
      planCampaign({ body: "Olá", manualValues: {}, limits, members: [member({ consentStatus: "UNKNOWN" })] }).blockers.join(),
    ).toMatch(/Não existem destinatários elegíveis/);
    const many = Array.from({ length: 3 }, (_, i) => member({ contactId: `c${i}` }));
    expect(planCampaign({ body: "Olá", manualValues: {}, limits: { maxRecipients: 2 }, members: many }).blockers.join()).toMatch(
      /máximo configurado é 2/,
    );
  });

  it("blocks messages that exceed SMS limits after rendering", () => {
    const plan = planCampaign({
      body: "ã".repeat(620) + " {{place}}",
      manualValues: { place: "Loja de Lisboa" },
      limits,
      members: [member()],
    });
    expect(plan.tooLong).toHaveLength(1);
    expect(plan.blockers.join()).toMatch(/tamanho máximo/);
  });

  it("never lets manual values override contact names", () => {
    const plan = planCampaign({ body: "Olá {{firstName}}", manualValues: { firstName: "X" }, limits, members: [member()] });
    expect(plan.recipients[0]).toMatchObject({ renderedBody: "Olá Maria" });
  });
});

describe("getCampaignLimits", () => {
  it("uses safe defaults and validates values", () => {
    expect(getCampaignLimits({})).toEqual({
      maxRecipients: 500,
      maxSendsPerMinute: 60,
      batchSize: 10,
      bulkConfirmationThreshold: 50,
      maxAttempts: 3,
    });
    expect(getCampaignLimits({ SMS_MAX_SENDS_PER_MINUTE: "120" }).maxSendsPerMinute).toBe(120);
    expect(() => getCampaignLimits({ SMS_CAMPAIGN_BATCH_SIZE: "0" })).toThrow();
    expect(() => getCampaignLimits({ SMS_MAX_RECIPIENTS_PER_CAMPAIGN: "abc" })).toThrow();
  });
});
