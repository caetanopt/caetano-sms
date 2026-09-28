/**
 * Templates de SMS com variáveis de uma whitelist explícita (CLAUDE.md §24).
 *
 * - Sintaxe: `{{nomeDaVariavel}}` (espaços interiores permitidos: `{{ date }}`).
 * - Nunca executa código: substituição textual numa única passagem, pelo que um
 *   valor que contenha `{{...}}` nunca é expandido.
 * - Variáveis em falta bloqueiam o envio; nunca se envia texto com placeholders.
 * - Telefone e email não são variáveis: evita colocar PII desnecessária no texto.
 */

export const TEMPLATE_VARIABLES = {
  firstName: { label: "Primeiro nome", source: "contact", sample: "Maria" },
  lastName: { label: "Apelido", source: "contact", sample: "Silva" },
  fullName: { label: "Nome completo", source: "contact", sample: "Maria Silva" },
  date: { label: "Data", source: "manual", sample: "12/10/2026" },
  time: { label: "Hora", source: "manual", sample: "14:30" },
  place: { label: "Local", source: "manual", sample: "Loja de Lisboa" },
} as const;

export type TemplateVariable = keyof typeof TEMPLATE_VARIABLES;
export type TemplateValues = Partial<Record<TemplateVariable, string>>;

export const TEMPLATE_VARIABLE_NAMES = Object.keys(TEMPLATE_VARIABLES) as TemplateVariable[];
export const MANUAL_VARIABLES = TEMPLATE_VARIABLE_NAMES.filter(
  (name) => TEMPLATE_VARIABLES[name].source === "manual",
);

export const MAX_VARIABLE_VALUE_LENGTH = 100;

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export function isTemplateVariable(name: string): name is TemplateVariable {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_VARIABLES, name);
}

export type TemplateAnalysis = {
  /** Variáveis usadas, por ordem de primeira ocorrência, sem repetições. */
  variables: TemplateVariable[];
  errors: string[];
};

export function analyzeTemplate(body: string): TemplateAnalysis {
  const variables: TemplateVariable[] = [];
  const errors: string[] = [];

  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (!isTemplateVariable(name)) {
      errors.push(name ? `Variável desconhecida: {{${name}}}.` : "Placeholder vazio: {{}}.");
    } else if (!variables.includes(name)) {
      variables.push(name);
    }
  }

  const leftover = body.replace(PLACEHOLDER, "");
  if (leftover.includes("{{") || leftover.includes("}}")) {
    errors.push("Placeholder mal formado: usa {{nomeDaVariavel}}.");
  }

  return { variables, errors: [...new Set(errors)] };
}

export function hasPlaceholderSyntax(text: string) {
  return text.includes("{{") || text.includes("}}");
}

/** Valida um valor introduzido pelo operador para uma variável manual. */
export function validateVariableValue(value: string): string | null {
  if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
    return `Valor demasiado longo (máx. ${MAX_VARIABLE_VALUE_LENGTH} caracteres).`;
  }
  if (hasPlaceholderSyntax(value)) return "O valor não pode conter {{ ou }}.";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "O valor não pode conter quebras de linha ou caracteres de controlo.";
  return null;
}

/** Variáveis derivadas do contacto. Ausentes quando não existe informação. */
export function contactVariables(contact: { name: string } | null): TemplateValues {
  if (!contact) return {};
  const fullName = contact.name.trim().replace(/\s+/g, " ");
  if (!fullName) return {};
  const parts = fullName.split(" ");
  const values: TemplateValues = { fullName, firstName: parts[0] };
  if (parts.length > 1) values.lastName = parts[parts.length - 1];
  return values;
}

export type RenderResult =
  | { ok: true; text: string; variables: TemplateVariable[] }
  | { ok: false; missing: TemplateVariable[]; errors: string[] };

export function renderTemplate(body: string, values: TemplateValues): RenderResult {
  const analysis = analyzeTemplate(body);
  if (analysis.errors.length > 0) return { ok: false, missing: [], errors: analysis.errors };

  const clean = (value: string | undefined) => value?.trim() ?? "";
  const missing = analysis.variables.filter((name) => clean(values[name]) === "");
  const invalid = analysis.variables
    .filter((name) => !missing.includes(name))
    .flatMap((name) => {
      const error = validateVariableValue(clean(values[name]));
      return error ? [`${TEMPLATE_VARIABLES[name].label}: ${error}`] : [];
    });
  if (missing.length > 0 || invalid.length > 0) return { ok: false, missing, errors: invalid };

  // Uma única passagem: o texto inserido nunca é reinterpretado.
  const text = body.replace(PLACEHOLDER, (_match, name: TemplateVariable) => clean(values[name]));
  if (hasPlaceholderSyntax(text)) {
    return { ok: false, missing: [], errors: ["O texto final contém placeholders por resolver."] };
  }
  return { ok: true, text, variables: analysis.variables };
}

export function sampleValues(): TemplateValues {
  return Object.fromEntries(TEMPLATE_VARIABLE_NAMES.map((name) => [name, TEMPLATE_VARIABLES[name].sample]));
}

export function describeMissing(missing: TemplateVariable[]) {
  return missing.map((name) => `{{${name}}} (${TEMPLATE_VARIABLES[name].label})`).join(", ");
}

export type RecipientRender =
  | { contactId: string; ok: true; text: string }
  | { contactId: string; ok: false; contactName: string; missing: TemplateVariable[]; errors: string[] };

/**
 * Resolve um template para vários destinatários (base das campanhas).
 * Devolve, por contacto, o texto final ou os campos em falta.
 */
export function renderForRecipients(
  body: string,
  recipients: Array<{ id: string; name: string }>,
  manualValues: TemplateValues,
): { results: RecipientRender[]; failures: Extract<RecipientRender, { ok: false }>[] } {
  const results = recipients.map((recipient): RecipientRender => {
    const rendered = renderTemplate(body, { ...manualValues, ...contactVariables(recipient) });
    return rendered.ok
      ? { contactId: recipient.id, ok: true, text: rendered.text }
      : {
          contactId: recipient.id,
          ok: false,
          contactName: recipient.name,
          missing: rendered.missing,
          errors: rendered.errors,
        };
  });
  return { results, failures: results.filter((result): result is Extract<RecipientRender, { ok: false }> => !result.ok) };
}
