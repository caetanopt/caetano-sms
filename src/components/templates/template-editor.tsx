"use client";

import { startTransition, useActionState, useMemo, useRef, useState, type FormEvent } from "react";
import { saveTemplateAction } from "@/app/actions/templates";
import { initialTemplateFormState } from "@/features/templates/template-form-state";
import { getSmsSegmentInfo } from "@/lib/sms/encoding";
import {
  analyzeTemplate,
  describeMissing,
  renderTemplate,
  sampleValues,
  TEMPLATE_VARIABLE_NAMES,
  TEMPLATE_VARIABLES,
  type TemplateValues,
  type TemplateVariable,
} from "@/lib/sms/templates";
import type { SmsMessageType } from "@/lib/sms/types";

const MAX_UNITS = { GSM_7: 1530, UCS_2: 630 } as const;
const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

export function TemplateEditor({
  template,
}: {
  template?: { id: string; name: string; body: string; messageType: SmsMessageType };
}) {
  const [state, formAction, pending] = useActionState(saveTemplateAction, initialTemplateFormState);
  const [name, setName] = useState(template?.name ?? "");
  const [body, setBody] = useState(template?.body ?? "");
  const [messageType, setMessageType] = useState<SmsMessageType | "">(template?.messageType ?? "");
  const [samples, setSamples] = useState<TemplateValues>(sampleValues);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const analysis = useMemo(() => analyzeTemplate(body), [body]);
  const preview = useMemo(() => renderTemplate(body, samples), [body, samples]);
  const segments = preview.ok ? getSmsSegmentInfo(preview.text) : null;
  const tooLong = segments ? segments.units > MAX_UNITS[segments.encoding] : false;
  const canSave = name.trim() !== "" && body.trim() !== "" && messageType !== "" && analysis.errors.length === 0 && !tooLong;

  function insert(variable: TemplateVariable) {
    const element = textarea.current;
    const token = `{{${variable}}}`;
    if (!element) {
      setBody((current) => current + token);
      return;
    }
    const start = element.selectionStart ?? body.length;
    const end = element.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  }

  // Submissão manual: evita o reset automático do formulário (React 19) que
  // apagaria o texto em caso de erro devolvido pelo servidor.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => formAction(new FormData(event.currentTarget)));
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
      {template ? <input type="hidden" name="templateId" value={template.id} /> : null}
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="body" value={body} />
      <input type="hidden" name="messageType" value={messageType} />

      <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-6">
        {state.error ? (
          <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{state.error}</div>
        ) : null}

        <label className="block text-sm font-medium">
          Nome
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} className={inputClass} />
        </label>

        <fieldset className="text-sm">
          <legend className="font-medium">Tipo de mensagem</legend>
          <div className="mt-2 flex gap-6">
            {(["TRANSACTIONAL", "PROMOTIONAL"] as const).map((type) => (
              <label key={type} className="flex items-center gap-2">
                <input type="radio" checked={messageType === type} onChange={() => setMessageType(type)} />
                {type === "TRANSACTIONAL" ? "Transacional" : "Promocional"}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Os envios que usem este template ficam obrigatoriamente com este tipo.
          </p>
        </fieldset>

        <div>
          <label className="block text-sm font-medium" htmlFor="template-body">Texto</label>
          <div className="mt-2 flex flex-wrap gap-2" aria-label="Inserir variável">
            {TEMPLATE_VARIABLE_NAMES.map((variable) => (
              <button
                key={variable}
                type="button"
                onClick={() => insert(variable)}
                className="rounded border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs hover:bg-slate-100"
                title={TEMPLATE_VARIABLES[variable].label}
              >
                {`{{${variable}}}`}
              </button>
            ))}
          </div>
          <textarea
            id="template-body"
            ref={textarea}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={8}
            maxLength={1530}
            className={`${inputClass} font-mono text-sm`}
            placeholder="Olá {{firstName}}, a sua marcação é no dia {{date}} às {{time}}."
          />
          {analysis.errors.length > 0 ? (
            <ul role="alert" className="mt-1 list-disc pl-5 text-xs text-red-700">
              {analysis.errors.map((error) => <li key={error}>{error}</li>)}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Variáveis usadas: {analysis.variables.length > 0 ? analysis.variables.map((v) => `{{${v}}}`).join(", ") : "nenhuma"}.
              Os nomes vêm do contacto; data, hora e local são indicados no envio.
            </p>
          )}
        </div>

        <button
          disabled={!canSave || pending}
          className="rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? "A guardar…" : template ? "Guardar alterações" : "Criar template"}
        </button>
      </section>

      <aside className="space-y-4 self-start rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-semibold">Pré-visualização</h2>
        {analysis.variables.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">Valores de exemplo (não são guardados):</p>
            {analysis.variables.map((variable) => (
              <label key={variable} className="block text-xs font-medium">
                {TEMPLATE_VARIABLES[variable].label} <span className="font-mono text-slate-500">{`{{${variable}}}`}</span>
                <input
                  value={samples[variable] ?? ""}
                  onChange={(event) => setSamples((current) => ({ ...current, [variable]: event.target.value }))}
                  className="mt-1 w-full rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
            ))}
          </div>
        ) : null}

        {preview.ok ? (
          <>
            <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{preview.text || "—"}</p>
            {segments ? (
              <p className={`text-xs ${tooLong ? "text-red-700" : "text-slate-500"}`} aria-live="polite">
                Estimativa: {segments.characters} caracteres · {segments.encoding === "GSM_7" ? "GSM-7" : "Unicode (UCS-2)"} ·{" "}
                {segments.segments} {segments.segments === 1 ? "parte" : "partes"}
                {tooLong ? ` · excede o máximo (${segments.units}/${MAX_UNITS[segments.encoding]})` : ""}
              </p>
            ) : null}
            <p className="text-xs text-slate-500">
              O número de partes real depende dos valores: nomes com ã, õ, ç ou emoji passam a Unicode (70 caracteres
              por parte em vez de 160).
            </p>
          </>
        ) : preview.missing.length > 0 ? (
          <p className="text-sm text-amber-800">Preenche os valores de exemplo: {describeMissing(preview.missing)}.</p>
        ) : (
          <p className="text-sm text-red-700">Corrige o template para ver a pré-visualização.</p>
        )}
      </aside>
    </form>
  );
}
