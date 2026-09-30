"use client";

import { startTransition, useActionState, useMemo, useState, type FormEvent } from "react";
import { sendSmsFormAction } from "@/app/actions/send-sms";
import type { SendFormState } from "@/features/messages/send-form-state";
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
import { QUOTA_RESET_TEXT } from "@/features/rate-limit/quota";

export type SendTemplateOption = { id: string; name: string; body: string; messageType: SmsMessageType };

const MAX_UNITS = { GSM_7: 1530, UCS_2: 630 } as const;

const TYPE_LABELS = { TRANSACTIONAL: "Transacional", PROMOTIONAL: "Promocional" } as const;

const CONSENT_LABELS = {
  UNKNOWN: "Desconhecido",
  OPTED_IN: "Opt-in",
  OPTED_OUT: "Opt-out",
} as const;

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

function SegmentCounter({ message, values }: { message: string; values: TemplateValues }) {
  const analysis = analyzeTemplate(message);
  if (analysis.errors.length > 0) {
    return (
      <p role="alert" className="mt-1 text-xs text-red-700">
        {analysis.errors.join(" ")}
      </p>
    );
  }
  // Variáveis ainda sem valor usam valores de exemplo só para a estimativa.
  const filled = { ...sampleValues(), ...Object.fromEntries(Object.entries(values).filter(([, v]) => v)) };
  const rendered = renderTemplate(message, filled);
  const info = getSmsSegmentInfo(rendered.ok ? rendered.text : message);
  const max = MAX_UNITS[info.encoding];
  const over = info.units > max;
  return (
    <p className={`mt-1 text-xs ${over ? "text-red-700" : "text-slate-500"}`} aria-live="polite">
      Estimativa{analysis.variables.length > 0 ? " (com valores de exemplo para variáveis por preencher)" : ""}:{" "}
      {info.characters} caracteres · {info.encoding === "GSM_7" ? "GSM-7" : "Unicode (UCS-2)"} · {info.segments}{" "}
      {info.segments === 1 ? "parte" : "partes"} · faltam {info.remainingInSegment} nesta parte
      {over ? ` · excede o máximo (${info.units}/${max})` : ""}
    </p>
  );
}

function ResultBanner({ result }: { result: NonNullable<SendFormState["result"]> }) {
  const styles = {
    accepted: "border-emerald-200 bg-emerald-50 text-emerald-800",
    duplicate: "border-slate-200 bg-slate-50 text-slate-800",
    failed: "border-red-200 bg-red-50 text-red-800",
    uncertain: "border-amber-300 bg-amber-50 text-amber-900",
  } as const;
  return (
    <div role="status" className={`mt-5 rounded-lg border p-3 text-sm ${styles[result.kind]}`}>
      {result.message}
    </div>
  );
}

export function SendForm({
  initialState,
  templates,
}: {
  initialState: SendFormState;
  templates: SendTemplateOption[];
}) {
  const [state, formAction, pending] = useActionState(sendSmsFormAction, initialState);
  const [values, setValues] = useState(state.values);
  const [lastValues, setLastValues] = useState(state.values);

  // Sincronizar com os valores devolvidos pelo servidor (erro, voltar, envio concluído).
  if (state.values !== lastValues) {
    setLastValues(state.values);
    setValues(state.values);
  }

  const template = templates.find((option) => option.id === values.templateId) ?? null;
  const manualVariables = useMemo(
    () => analyzeTemplate(values.message).variables.filter((name) => MANUAL_VARIABLES.includes(name)),
    [values.message],
  );
  const update = (patch: Partial<typeof values>) => setValues((current) => ({ ...current, ...patch }));

  function chooseTemplate(templateId: string) {
    const chosen = templates.find((option) => option.id === templateId);
    if (!chosen) {
      update({ templateId: "" });
      return;
    }
    update({ templateId: chosen.id, message: chosen.body, messageType: chosen.messageType });
  }

  // Submissão manual: o React 19 reinicia o formulário após uma action, o que
  // dessincronizaria os campos controlados do estado (ver importação CSV).
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(() => formAction(new FormData(event.currentTarget)));
  }

  if (state.step === "review" && state.review) {
    const review = state.review;
    const rows: Array<[string, string]> = [
      ["Destinatário (E.164)", review.phoneE164],
      [
        "Contacto",
        review.contactName
          ? `${review.contactName} — consentimento: ${CONSENT_LABELS[review.consentStatus ?? "UNKNOWN"]}`
          : "Número sem contacto registado",
      ],
      ["Tipo", TYPE_LABELS[review.messageType]],
      ["Template", review.templateName ?? "Texto livre"],
      [
        "Encoding / partes (estimativa)",
        `${review.segments.encoding === "GSM_7" ? "GSM-7" : "Unicode (UCS-2)"} · ${review.segments.characters} caracteres · ${review.segments.segments} ${review.segments.segments === 1 ? "parte" : "partes"}`,
      ],
      ["Origem", review.originationLabel],
      ["Modo", review.mode === "TEST" ? "TESTE" : "PRODUÇÃO"],
    ];
    if (!review.contactName && review.legalBasisConfirmed) {
      rows.push(["Base legal", "Confirmada pelo operador"]);
    }
    if (review.quota) {
      rows.push([
        "Quota diária após este envio",
        `${review.quota.afterSend} de ${review.quota.limit} partes SMS disponíveis · ${QUOTA_RESET_TEXT}` +
          (review.quota.committed > 0
            ? ` · atenção: ${review.quota.committed} estão reservadas para campanhas tuas por enviar; se as usares aqui, essas campanhas serão pausadas`
            : ""),
      ]);
    }

    return (
      <form action={formAction} className="mt-6 space-y-5 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">Confirmar envio</h2>
        <dl className="divide-y divide-slate-100 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[220px_1fr] gap-4 py-2">
              <dt className="text-slate-500">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <div>
          <p className="text-sm text-slate-500">Mensagem final (variáveis resolvidas)</p>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{review.renderedMessage}</p>
        </div>

        <input type="hidden" name="requestId" value={state.requestId} />
        <input type="hidden" name="phone" value={state.values.phone} />
        <input type="hidden" name="message" value={state.values.message} />
        <input type="hidden" name="messageType" value={state.values.messageType} />
        {state.values.legalBasis ? <input type="hidden" name="legalBasis" value="on" /> : null}
        <input type="hidden" name="templateId" value={state.values.templateId} />
        {MANUAL_VARIABLES.map((name) =>
          state.values.variables[name] ? (
            <input key={name} type="hidden" name={`var_${name}`} value={state.values.variables[name]} />
          ) : null,
        )}

        <div className="flex gap-3">
          <button
            name="intent"
            value="confirm"
            disabled={pending}
            className="rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {pending ? "A enviar…" : "Confirmar e enviar"}
          </button>
          <button
            name="intent"
            value="edit"
            disabled={pending}
            className="rounded-lg border border-slate-300 px-5 py-2.5 font-semibold hover:bg-slate-50 disabled:opacity-50"
          >
            Voltar e editar
          </button>
        </div>
      </form>
    );
  }

  return (
    <>
      {state.result ? <ResultBanner result={state.result} /> : null}
      {state.error ? (
        <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {state.error}
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="mt-6 space-y-5 rounded-xl border border-slate-200 bg-white p-6">
        {/* Valores enviados derivam do estado React. */}
        <input type="hidden" name="requestId" value={state.requestId} />
        <input type="hidden" name="intent" value="review" />
        <input type="hidden" name="phone" value={values.phone} />
        <input type="hidden" name="message" value={values.message} />
        <input type="hidden" name="messageType" value={values.messageType} />
        <input type="hidden" name="templateId" value={values.templateId} />
        {values.legalBasis ? <input type="hidden" name="legalBasis" value="on" /> : null}
        {manualVariables.map((name) => (
          <input key={name} type="hidden" name={`var_${name}`} value={values.variables[name] ?? ""} />
        ))}

        <label className="block text-sm font-medium">
          Destinatário
          <input
            required
            value={values.phone}
            onChange={(event) => update({ phone: event.target.value })}
            placeholder="912 345 678 ou +351912345678"
            className={inputClass}
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">
            Portugal (+351) assumido quando não é indicado o indicativo.
          </span>
        </label>

        {templates.length > 0 ? (
          <label className="block text-sm font-medium">
            Template (opcional)
            <select
              value={values.templateId}
              onChange={(event) => chooseTemplate(event.target.value)}
              className={inputClass}
            >
              <option value="">— texto livre —</option>
              {templates.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name} ({TYPE_LABELS[option.messageType]})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <fieldset className="text-sm">
          <legend className="font-medium">Tipo de mensagem</legend>
          <div className="mt-2 flex gap-6">
            {(["TRANSACTIONAL", "PROMOTIONAL"] as const).map((type) => (
              <label key={type} className="flex items-center gap-2">
                <input
                  type="radio"
                  value={type}
                  checked={values.messageType === type}
                  disabled={template !== null && template.messageType !== type}
                  onChange={() => update({ messageType: type })}
                />
                {TYPE_LABELS[type]}
              </label>
            ))}
          </div>
          {template ? (
            <p className="mt-1 text-xs text-slate-500">O tipo é definido pelo template e não pode ser alterado.</p>
          ) : null}
        </fieldset>

        <label className="block text-sm font-medium">
          Mensagem
          <textarea
            required
            rows={7}
            value={values.message}
            readOnly={template !== null}
            onChange={(event) => update({ message: event.target.value })}
            className={`${inputClass} ${template ? "bg-slate-50 text-slate-600" : ""}`}
            placeholder="Escreve a mensagem..."
          />
          {template ? (
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Texto do template (só leitura). Para editar livremente escolhe “texto livre”.
            </span>
          ) : null}
          <SegmentCounter message={values.message} values={values.variables} />
        </label>

        {manualVariables.length > 0 ? (
          <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-3">
            <legend className="px-1 text-sm font-medium">Valores das variáveis</legend>
            {manualVariables.map((name) => (
              <label key={name} className="block text-sm">
                {TEMPLATE_VARIABLES[name].label} <span className="font-mono text-xs text-slate-500">{`{{${name}}}`}</span>
                <input
                  required
                  maxLength={100}
                  value={values.variables[name] ?? ""}
                  onChange={(event) => update({ variables: { ...values.variables, [name]: event.target.value } })}
                  placeholder={TEMPLATE_VARIABLES[name].sample}
                  className={inputClass}
                />
              </label>
            ))}
            <p className="text-xs text-slate-500 sm:col-span-3">
              Nomes ({"{{firstName}}"}, {"{{lastName}}"}, {"{{fullName}}"}) vêm do contacto registado com este número.
            </p>
          </fieldset>
        ) : null}

        <label className="flex items-start gap-3 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-1"
            checked={values.legalBasis}
            onChange={(event) => update({ legalBasis: event.target.checked })}
          />
          <span>
            Para um número ainda não registado como contacto, confirmo que existe consentimento/base legal adequada,
            especialmente se a mensagem for promocional.
          </span>
        </label>

        <button
          disabled={pending}
          className="rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? "A validar…" : "Rever envio"}
        </button>
      </form>
    </>
  );
}
