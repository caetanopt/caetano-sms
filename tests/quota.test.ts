import { describe, expect, it } from "vitest";
import {
  campaignPaceTooHighMessage,
  campaignPaceWaitReason,
  confirmationQuotaBlocker,
  describeQuota,
  effectiveDailyLimit,
  effectivePerMinute,
  NOT_SENT_ERROR_CODES,
  quotaAllows,
  quotaBlockedMessage,
  quotaState,
  resumeBlockedByQuotaMessage,
  userQuotaHaltMessage,
} from "@/features/rate-limit/quota";

const now = new Date("2026-09-30T10:00:00Z");

describe("quota rules", () => {
  it("resolves the effective daily limit and campaign pace", () => {
    expect(effectiveDailyLimit(null, 2000)).toBe(2000);
    expect(effectiveDailyLimit(0, 2000)).toBe(0);
    expect(effectiveDailyLimit(5, 2000)).toBe(5);
    expect(effectivePerMinute(60, null)).toBe(60);
    expect(effectivePerMinute(60, 10)).toBe(10);
    // Um ritmo por campanha nunca alarga o global.
    expect(effectivePerMinute(60, 100)).toBe(60);
  });

  it("builds the state on the Lisbon day and clamps the remainder", () => {
    const state = quotaState({ limit: 2000, used: 2500, now });
    expect(state).toMatchObject({ limit: 2000, used: 2500, remaining: 0, day: "2026-09-30" });
    expect(state.resetsAt.toISOString()).toBe("2026-09-30T23:00:00.000Z"); // 00:00 de 1 de outubro em Lisboa (verão)
  });

  it("never rounds: a send only passes when it fits entirely", () => {
    expect(quotaAllows(quotaState({ limit: 10, used: 9, now }), 1)).toBe(true);
    expect(quotaAllows(quotaState({ limit: 10, used: 9, now }), 2)).toBe(false);
    expect(quotaAllows(quotaState({ limit: 10, used: 8, now }), 3)).toBe(false);
    expect(quotaAllows(quotaState({ limit: 0, used: 0, now }), 1)).toBe(false);
  });

  it("lists only errors that guarantee the message never left", () => {
    expect(NOT_SENT_ERROR_CODES).toContain("THROTTLED");
    expect(NOT_SENT_ERROR_CODES).not.toContain("OPTED_OUT");
    expect(NOT_SENT_ERROR_CODES).not.toContain("UNKNOWN");
  });
});

describe("quota messages (PT-PT, actionable)", () => {
  it("describes and blocks with numbers and the reset time", () => {
    const state = quotaState({ limit: 2000, used: 120, now });
    expect(describeQuota(state)).toBe("120 de 2000 partes SMS usadas hoje · 1880 disponíveis · reinicia às 00:00 (hora de Lisboa)");
    expect(quotaBlockedMessage(quotaState({ limit: 0, used: 0, now }), 1)).toMatch(/não tem quota de envio/);
    expect(quotaBlockedMessage(quotaState({ limit: 2, used: 0, now }), 3)).toMatch(/precisa de 3 partes SMS, acima da tua quota diária \(2\)/);
    expect(quotaBlockedMessage(quotaState({ limit: 10, used: 9, now }), 2)).toMatch(/usaste 9 de 10 partes SMS hoje e esta mensagem precisa de 2.*00:00 \(hora de Lisboa\)/);
    expect(userQuotaHaltMessage(quotaState({ limit: 10, used: 10, now }))).toMatch(/Envio parado.*10 de 10.*não se repetem/);
    expect(resumeBlockedByQuotaMessage(quotaState({ limit: 10, used: 10, now }))).toMatch(/Não é possível retomar.*10 de 10/);
    expect(campaignPaceWaitReason(30)).toBe("Ritmo máximo desta campanha (30 mensagens por minuto).");
    expect(campaignPaceTooHighMessage(60)).toMatch(/não pode exceder o limite global \(60 mensagens por minuto\)/);
  });

  it("explains a confirmation blocker with and without committed parts", () => {
    const state = quotaState({ limit: 100, used: 40, now });
    expect(confirmationQuotaBlocker({ required: 70, state, committed: { parts: 0, names: [] } })).toBe(
      "A campanha precisa de 70 partes SMS e a tua quota diária tem 60 disponíveis (40 de 100 usadas hoje). Reduz a lista, espera pelo reinício às 00:00 (hora de Lisboa) ou pede a um administrador para ajustar a tua quota.",
    );
    expect(confirmationQuotaBlocker({ required: 50, state, committed: { parts: 20, names: ["Outubro", "Natal (pausada)"] } })).toMatch(
      /tem 40 disponíveis \(40 de 100 usadas hoje; 20 reservadas em «Outubro», «Natal \(pausada\)»\)/,
    );
    expect(confirmationQuotaBlocker({ required: 1, state, committed: { parts: 500, names: ["X"] } })).toMatch(/tem 0 disponíveis/);
  });
});
