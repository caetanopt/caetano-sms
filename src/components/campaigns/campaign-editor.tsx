"use client";

import { startTransition, useActionState, useMemo, useState, type FormEvent } from "react";
import { saveCampaignDraftAction, type CampaignFormState } from "@/app/actions/campaigns";
import { getSmsSegmentInfo } from "@/lib/sms/encoding";
import {
  analyzeTemplate,
  MANUAL_VARIABLES,
  renderTemplate,
  sampleValues,
  TEMPLATE_VARIABLES,
  type TemplateValues,
} from "@/lib/sms/templates";
import type { SmsMessageType } from "@/lib/sms/types";

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";
const TYPE_LABELS = { TRANSACTIONAL: "Transacional", PROMOTIONAL: "Promocional" } as const;

export type EditorTemplate = { id: string; name: string; body: string; messageType: SmsMessageType };
export type EditorList = { id: string; name: string; members: number };

export function CampaignEditor({
  campaign,
  lists,
  templates,
  globalMaxPerMinute,
}: {
  campaign?: {
    id: string;
    name: string;
    listId: string | null;
    templateId: string | null;
    messageBody: string;
    messageType: SmsMessageType;
    variables: TemplateValues;
    maxSendsPerMinute: number | null;
  };
  lists: EditorList[];
  templates: EditorTemplate[];
  /** SMS_MAX_SENDS_PER_MINUTE: o ritmo da campanha só pode ser inferior. */
  globalMaxPerMinute: number;
}) {
  const [state, formAction, pending] = useActionState<CampaignFormState, FormData>(saveCampaignDraftAction, {});
  const [name, setName] = useState(campaign?.name ?? "");
  const [listId, setListId] = useState(campaign?.listId ?? "");
  const [templateId, setTemplateId] = useState(campaign?.templateId ?? "");
  const [body, setBody] = useState(campaign?.messageBody ?? "");
  const [messageType, setMessageType] = useState<SmsMessageType | "">(campaign?.messageType ?? "");
  const [variables, setVariables] = useState<TemplateValues>(campaign?.variables ?? {});
  const [maxPerMinute, setMaxPerMinute] = useState(campaign?.maxSendsPerMinute?.toString() ?? "");

  const template = templates.find((option) => option.id === templateId) ?? null;
  const effectiveBody = template ? template.body : body;
  const analysis = useMemo(() => analyzeTemplate(effectiveBody), [effectiveBody]);
  const manualVariables = analysis.variables.filter((name) => MANUAL_VARIABLES.includes(name));
  const estimate = useMemo(() => {
    const filled = { ...sampleValues(), ...Object.fromEntries(Object.entries(variables).filter(([, v]) => v)) };
    const rendered = renderTemplate(effectiveBody, filled);
    return rendered.ok ? { text: rendered.text, info: getSmsSegmentInfo(rendered.text) } : null;
  }, [effectiveBody, variables]);

  function chooseTemplate(id: string) {
    setTemplateId(id);
    const chosen = templates.find((option) => option.id === id);
    if (chosen) {
      setMessageType(chosen.messageType);
      setBody(chosen.body);
    }
  }

  // Submissão manual (evita o reset automático do React 19; ver send-form.tsx).
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => formAction(new FormData(event.currentTarget)));
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-5 rounded-xl border border-slate-200 bg-white p-6">
      {campaign ? <input type="hidden" name="campaignId" value={campaign.id} /> : null}
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="listId" value={listId} />
      <input type="hidden" name="templateId" value={templateId} />
      <input type="hidden" name="messageBody" value={effectiveBody} />
      <input type="hidden" name="messageType" value={messageType} />
      <input type="hidden" name="maxSendsPerMinute" value={maxPerMinute} />
      {manualVariables.map((variable) => (
        <input key={variable} type="hidden" name={`var_${variable}`} value={variables[variable] ?? ""} />
      ))}

      {state.error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{state.error}</div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Nome da campanha
          <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} className={inputClass} />
        </label>
        <label className="block text-sm font-medium">
          Lista de destinatários
          <select value={listId} onChange={(event) => setListId(event.target.value)} required className={inputClass}>
            <option value="">— seleciona —</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name} ({list.members} contactos)
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block text-sm font-medium">
        Template
        <select value={templateId} onChange={(event) => chooseTemplate(event.target.value)} className={inputClass}>
          <option value="">— texto livre —</option>
          {templates.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name} ({TYPE_LABELS[option.messageType]})
            </option>
          ))}
        </select>
      </label>

      <fieldset className="text-sm">
        <legend className="font-medium">Tipo de mensagem</legend>
        <div className="mt-2 flex gap-6">
          {(["TRANSACTIONAL", "PROMOTIONAL"] as const).map((type) => (
            <label key={type} className="flex items-center gap-2">
              <input
                type="radio"
                value={type}
                checked={messageType === type}
                disabled={template !== null && template.messageType !== type}
                onChange={() => setMessageType(type)}
              />
              {TYPE_LABELS[type]}
            </label>
          ))}
        </div>
        {template ? <p className="mt-1 text-xs text-slate-500">O tipo é definido pelo template.</p> : null}
      </fieldset>

      <label className="block text-sm font-medium">
        Ritmo máximo (mensagens por minuto) — opcional
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={globalMaxPerMinute}
          step={1}
          value={maxPerMinute}
          onChange={(event) => setMaxPerMinute(event.target.value)}
          placeholder={`limite global: ${globalMaxPerMinute}`}
          className={inputClass}
        />
        <span className="mt-1 block text-xs font-normal text-slate-500">
          Deixa vazio para usar o limite global ({globalMaxPerMinute} mensagens por minuto). O valor tem de ser igual ou
          inferior a esse limite; um ritmo mais baixo espalha o envio no tempo.
        </span>
      </label>

      <label className="block text-sm font-medium">
        Mensagem
        <textarea
          rows={6}
          value={effectiveBody}
          readOnly={template !== null}
          onChange={(event) => setBody(event.target.value)}
          className={`${inputClass} font-mono text-sm ${template ? "bg-slate-50 text-slate-600" : ""}`}
          placeholder="Olá {{firstName}}, …"
        />
        {analysis.errors.length > 0 ? (
          <span role="alert" className="mt-1 block text-xs text-red-700">{analysis.errors.join(" ")}</span>
        ) : estimate ? (
          <span className="mt-1 block text-xs font-normal text-slate-500" aria-live="polite">
            Estimativa com valores de exemplo: {estimate.info.characters} caracteres ·{" "}
            {estimate.info.encoding === "GSM_7" ? "GSM-7" : "Unicode (UCS-2)"} · {estimate.info.segments}{" "}
            {estimate.info.segments === 1 ? "parte" : "partes"} por destinatário. O valor exato por contacto aparece na revisão.
          </span>
        ) : null}
      </label>

      {manualVariables.length > 0 ? (
        <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-3">
          <legend className="px-1 text-sm font-medium">Valores comuns a todos os destinatários</legend>
          {manualVariables.map((variable) => (
            <label key={variable} className="block text-sm">
              {TEMPLATE_VARIABLES[variable].label} <span className="font-mono text-xs text-slate-500">{`{{${variable}}}`}</span>
              <input
                maxLength={100}
                value={variables[variable] ?? ""}
                onChange={(event) => setVariables((current) => ({ ...current, [variable]: event.target.value }))}
                placeholder={TEMPLATE_VARIABLES[variable].sample}
                className={inputClass}
              />
            </label>
          ))}
        </fieldset>
      ) : null}

      <p className="text-xs text-slate-500">Guardar o rascunho nunca envia mensagens.</p>
      <button
        disabled={pending}
        className="rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {pending ? "A guardar…" : campaign ? "Guardar rascunho" : "Criar rascunho"}
      </button>
    </form>
  );
}
