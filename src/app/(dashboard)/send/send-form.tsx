"use client";

import { useActionState, useState } from "react";
import { sendSmsFormAction } from "@/app/actions/send-sms";
import type { SendFormState } from "@/features/messages/send-form-state";
import { getSmsSegmentInfo } from "@/lib/sms/encoding";

const MAX_UNITS = { GSM_7: 1530, UCS_2: 630 } as const;

const TYPE_LABELS = { TRANSACTIONAL: "Transacional", PROMOTIONAL: "Promocional" } as const;

const CONSENT_LABELS = {
  UNKNOWN: "Desconhecido",
  OPTED_IN: "Opt-in",
  OPTED_OUT: "Opt-out",
} as const;

const inputClass = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

function SegmentCounter({ message }: { message: string }) {
  const info = getSmsSegmentInfo(message);
  const max = MAX_UNITS[info.encoding];
  const over = info.units > max;
  return (
    <p className={`mt-1 text-xs ${over ? "text-red-700" : "text-slate-500"}`} aria-live="polite">
      Estimativa: {info.characters} caracteres · {info.encoding === "GSM_7" ? "GSM-7" : "Unicode (UCS-2)"} ·{" "}
      {info.segments} {info.segments === 1 ? "parte" : "partes"} · faltam {info.remainingInSegment} nesta parte
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

export function SendForm({ initialState }: { initialState: SendFormState }) {
  const [state, formAction, pending] = useActionState(sendSmsFormAction, initialState);
  const [message, setMessage] = useState(state.values.message);
  const [lastValues, setLastValues] = useState(state.values);

  // Sincronizar o texto quando o servidor devolve novos valores (ex.: após envio).
  if (state.values !== lastValues) {
    setLastValues(state.values);
    setMessage(state.values.message);
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
          <p className="text-sm text-slate-500">Mensagem</p>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm">{state.values.message}</p>
        </div>

        <input type="hidden" name="requestId" value={state.requestId} />
        <input type="hidden" name="phone" value={state.values.phone} />
        <input type="hidden" name="message" value={state.values.message} />
        <input type="hidden" name="messageType" value={state.values.messageType} />
        {state.values.legalBasis ? <input type="hidden" name="legalBasis" value="on" /> : null}

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

      <form
        key={state.requestId}
        action={formAction}
        className="mt-6 space-y-5 rounded-xl border border-slate-200 bg-white p-6"
      >
        <input type="hidden" name="requestId" value={state.requestId} />
        <input type="hidden" name="intent" value="review" />

        <label className="block text-sm font-medium">
          Destinatário
          <input
            name="phone"
            required
            defaultValue={state.values.phone}
            placeholder="912 345 678 ou +351912345678"
            className={inputClass}
          />
          <span className="mt-1 block text-xs font-normal text-slate-500">
            Portugal (+351) assumido quando não é indicado o indicativo.
          </span>
        </label>

        <fieldset className="text-sm">
          <legend className="font-medium">Tipo de mensagem</legend>
          <div className="mt-2 flex gap-6">
            {(["TRANSACTIONAL", "PROMOTIONAL"] as const).map((type) => (
              <label key={type} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="messageType"
                  value={type}
                  required
                  defaultChecked={state.values.messageType === type}
                />
                {TYPE_LABELS[type]}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="block text-sm font-medium">
          Mensagem
          <textarea
            name="message"
            required
            rows={7}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            className={inputClass}
            placeholder="Escreve a mensagem..."
          />
          <SegmentCounter message={message} />
        </label>

        <label className="flex items-start gap-3 text-sm text-slate-700">
          <input name="legalBasis" type="checkbox" className="mt-1" defaultChecked={state.values.legalBasis} />
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
