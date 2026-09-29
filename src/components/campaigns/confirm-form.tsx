"use client";

import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useState, type FormEvent } from "react";
import { confirmCampaignAction, type ConfirmFormState } from "@/app/actions/campaigns";

export const AUTOSTART_KEY = (campaignId: string) => `campaign-autostart:${campaignId}`;

export function ConfirmForm({
  campaignId,
  fingerprint,
  requiredText,
  promotional,
  eligible,
}: {
  campaignId: string;
  fingerprint: string;
  requiredText: string | null;
  promotional: boolean;
  eligible: number;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ConfirmFormState, FormData>(confirmCampaignAction, {});
  const [text, setText] = useState("");
  const [purposeAck, setPurposeAck] = useState(false);

  useEffect(() => {
    if (state.confirmed) {
      // A confirmação é a ação explícita que inicia o envio neste separador.
      try {
        sessionStorage.setItem(AUTOSTART_KEY(campaignId), "1");
      } catch {
        /* sem sessionStorage: o operador inicia manualmente */
      }
      router.refresh();
    }
  }, [state.confirmed, campaignId, router]);

  const textOk = requiredText === null || text.trim() === requiredText;
  const canSubmit = textOk && (!promotional || purposeAck) && !pending;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    startTransition(() => formAction(new FormData(event.currentTarget)));
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <input type="hidden" name="confirmationText" value={text} />
      {purposeAck ? <input type="hidden" name="purposeAcknowledged" value="on" /> : null}

      {state.error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {state.error}
          {/fingerprint|mudaram/i.test(state.error) ? (
            <button type="button" onClick={() => router.refresh()} className="ml-2 font-semibold underline">
              Rever novamente
            </button>
          ) : null}
        </div>
      ) : null}

      {promotional ? (
        <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <input type="checkbox" checked={purposeAck} onChange={(event) => setPurposeAck(event.target.checked)} className="mt-1" />
          <span>
            Confirmo que o consentimento destes {eligible} destinatários abrange comunicações de marketing (ver finalidades
            acima). Esta confirmação fica registada na auditoria.
          </span>
        </label>
      ) : null}

      {requiredText ? (
        <label className="block text-sm font-medium">
          Para confirmar o envio em massa escreve <code className="rounded bg-slate-100 px-1">{requiredText}</code>
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            autoComplete="off"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono sm:w-72"
          />
        </label>
      ) : null}

      <button
        disabled={!canSubmit}
        className="rounded-lg bg-red-700 px-5 py-2.5 font-semibold text-white hover:bg-red-800 disabled:opacity-50"
      >
        {pending ? "A confirmar…" : "Confirmar e enviar"}
      </button>
    </form>
  );
}
