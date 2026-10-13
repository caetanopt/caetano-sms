import { describe, expect, it } from "vitest";
import {
  analyzeTemplate,
  contactVariables,
  describeMissing,
  renderForRecipients,
  renderTemplate,
  sampleValues,
  validateVariableValue,
} from "../src/lib/sms/templates";

const EXAMPLE = "Olá {{firstName}}, a sua marcação é no dia {{date}} às {{time}}.";

describe("analyzeTemplate", () => {
  it("lists whitelisted variables once, in order", () => {
    expect(analyzeTemplate(`${EXAMPLE} Até {{ date }}!`)).toEqual({
      variables: ["firstName", "date", "time"],
      errors: [],
    });
  });

  it("accepts plain text and GSM single braces", () => {
    expect(analyzeTemplate("Código {1234} [ok]")).toEqual({ variables: [], errors: [] });
  });

  it.each([
    ["Olá {{nome}}", /desconhecida: \{\{nome\}\}/],
    ["Olá {{phone}}", /desconhecida/],
    ["Olá {{}}", /vazio/],
    ["Olá {{firstName}", /mal formado/],
    ["Olá firstName}}", /mal formado/],
    ["Olá {{constructor}}", /desconhecida/],
    ["Olá {{__proto__}}", /desconhecida/],
    ["{{ firstName.length }}", /desconhecida/],
  ])("rejects %s", (body, error) => {
    expect(analyzeTemplate(body).errors.join(" ")).toMatch(error);
  });
});

describe("renderTemplate", () => {
  it("renders the CLAUDE.md example", () => {
    expect(renderTemplate(EXAMPLE, { firstName: "Maria", date: "12/10", time: "14:30" })).toEqual({
      ok: true,
      text: "Olá Maria, a sua marcação é no dia 12/10 às 14:30.",
      variables: ["firstName", "date", "time"],
    });
  });

  it("blocks when variables are missing or blank and names them", () => {
    const result = renderTemplate(EXAMPLE, { firstName: "Maria", date: "  " });
    expect(result).toEqual({ ok: false, missing: ["date", "time"], errors: [] });
    if (!result.ok) expect(describeMissing(result.missing)).toBe("{{date}} (Data), {{time}} (Hora)");
  });

  it("never expands placeholders contained in values (single pass)", () => {
    const result = renderTemplate("Olá {{firstName}}", { firstName: "{{date}}", date: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/não pode conter/);
  });

  it("does not evaluate anything", () => {
    const result = renderTemplate("Olá {{firstName}}", { firstName: "${process.env.AUTH_SECRET}" });
    expect(result).toMatchObject({ ok: true, text: "Olá ${process.env.AUTH_SECRET}" });
  });

  it("rejects control characters and overly long values", () => {
    expect(renderTemplate("{{place}}", { place: "a\nb" }).ok).toBe(false);
    expect(renderTemplate("{{place}}", { place: "x".repeat(101) }).ok).toBe(false);
  });

  it("ignores values for variables the template does not use", () => {
    expect(renderTemplate("Olá", { place: "{{bad}}" })).toMatchObject({ ok: true, text: "Olá" });
  });

  it("refuses to render invalid templates", () => {
    expect(renderTemplate("Olá {{nome}}", sampleValues())).toMatchObject({ ok: false });
  });

  it("renders with sample values", () => {
    expect(renderTemplate(EXAMPLE, sampleValues())).toMatchObject({ ok: true });
  });
});

describe("contactVariables", () => {
  it("derives first, last and full name", () => {
    expect(contactVariables({ name: "  Maria  da  Conceição Silva " })).toEqual({
      fullName: "Maria da Conceição Silva",
      firstName: "Maria",
      lastName: "Silva",
    });
  });

  it("omits lastName for single names and everything without contact", () => {
    expect(contactVariables({ name: "Maria" })).toEqual({ fullName: "Maria", firstName: "Maria" });
    expect(contactVariables(null)).toEqual({});
  });
});

describe("renderForRecipients", () => {
  it("reports the contact and field that are missing", () => {
    const { results, failures } = renderForRecipients(
      "Olá {{firstName}} {{lastName}}, até {{date}}.",
      [
        { id: "c1", name: "Maria Silva" },
        { id: "c2", name: "Rui" },
      ],
      { date: "12/10" },
    );
    expect(results[0]).toEqual({ contactId: "c1", ok: true, text: "Olá Maria Silva, até 12/10." });
    expect(failures).toEqual([{ contactId: "c2", ok: false, contactName: "Rui", missing: ["lastName"], errors: [] }]);
  });

  it("does not let manual values override contact variables", () => {
    const { results } = renderForRecipients("Olá {{firstName}}", [{ id: "c1", name: "Maria" }], { firstName: "X" });
    expect(results[0]).toMatchObject({ ok: true, text: "Olá Maria" });
  });
});

describe("validateVariableValue", () => {
  it("accepts ordinary Portuguese text", () => {
    expect(validateVariableValue("Loja do Chiado, 2.º andar")).toBeNull();
  });
});
