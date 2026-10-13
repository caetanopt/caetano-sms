import { getSmsSegmentInfo, type SmsSegmentInfo } from "@/lib/sms/encoding";
import { analyzeTemplate, renderTemplate, sampleValues, type TemplateVariable } from "@/lib/sms/templates";

const MAX_UNITS = { GSM_7: 1530, UCS_2: 630 } as const;

export type TemplateCheck =
  | { ok: true; variables: TemplateVariable[]; sampleText: string; sampleSegments: SmsSegmentInfo }
  | { ok: false; errors: string[] };

/**
 * Valida um template antes de o guardar: sintaxe, whitelist de variáveis e
 * limites SMS com valores de exemplo (o tamanho real depende dos valores).
 */
export function checkTemplateBody(body: string): TemplateCheck {
  if (body.trim().length === 0) return { ok: false, errors: ["O texto do template está vazio."] };

  const analysis = analyzeTemplate(body);
  if (analysis.errors.length > 0) return { ok: false, errors: analysis.errors };

  const rendered = renderTemplate(body, sampleValues());
  if (!rendered.ok) return { ok: false, errors: rendered.errors };

  const segments = getSmsSegmentInfo(rendered.text);
  const max = MAX_UNITS[segments.encoding];
  if (segments.units > max) {
    return {
      ok: false,
      errors: [`Mensagem demasiado longa para SMS com valores de exemplo (${segments.units}/${max}).`],
    };
  }
  return { ok: true, variables: analysis.variables, sampleText: rendered.text, sampleSegments: segments };
}
