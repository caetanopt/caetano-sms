import { describe, expect, it } from "vitest";
import { checkTemplateBody } from "../src/features/templates/template-rules";

describe("checkTemplateBody", () => {
  it("accepts a valid template and estimates segments with sample values", () => {
    const result = checkTemplateBody("Olá {{firstName}}, a sua marcação é no dia {{date}} às {{time}}.");
    expect(result).toMatchObject({
      ok: true,
      variables: ["firstName", "date", "time"],
      // "marcação" (ç minúsculo, ã) não pertence ao GSM 03.38: o exemplo do CLAUDE.md é UCS-2.
      sampleSegments: { encoding: "UCS_2", segments: 1, characters: 55 },
    });
    expect(checkTemplateBody("Ola {{firstName}}, a sua consulta e dia {{date}}.")).toMatchObject({
      ok: true,
      sampleSegments: { encoding: "GSM_7", segments: 1 },
    });
  });

  it("rejects empty, unknown variables and oversized templates", () => {
    expect(checkTemplateBody("   ")).toMatchObject({ ok: false });
    expect(checkTemplateBody("Olá {{nome}}")).toMatchObject({ ok: false, errors: [expect.stringMatching(/desconhecida/)] });
    expect(checkTemplateBody("ã".repeat(620) + " {{place}}")).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/demasiado longa/)],
    });
  });
});
