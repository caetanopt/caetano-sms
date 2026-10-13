"use client";

import { useActionState, useState, type ReactNode } from "react";
import { confirmMfaEnrollmentAction, disableMfaAction, regenerateRecoveryCodesAction, startMfaEnrollmentAction } from "@/app/actions/mfa";
import { initialMfaFormState } from "@/features/auth/mfa-form-state";

export type MfaPanelStatus = {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesRemaining: number;
  required: boolean;
  pending: { secretDisplay: string; uri: string } | null;
};

const input = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono tracking-widest";
const button = "rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60";

function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">Códigos de recuperação — guarda-os agora</p>
      <p className="mt-1">
        Só são mostrados esta vez. Cada código permite entrar uma única vez se perderes o telemóvel. Guarda-os num gestor de
        palavras-passe ou em papel, num local seguro.
      </p>
      <ul data-testid="recovery-codes" className="mt-3 grid grid-cols-2 gap-2 font-mono text-base sm:grid-cols-5">
        {codes.map((code) => <li key={code} className="rounded bg-white px-2 py-1 text-center">{code}</li>)}
      </ul>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(codes.join("\n"));
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
        className="mt-3 rounded-lg border border-amber-400 px-3 py-2 hover:bg-amber-100"
      >
        {copied ? "Copiados" : "Copiar códigos"}
      </button>
    </div>
  );
}

/**
 * Um único componente cliente para todos os estados: a sessão é renovada pelas actions (o que
 * atualiza a página) e os códigos de recuperação, que só existem no estado, não se perdem.
 */
export function MfaPanel({ status, qr }: { status: MfaPanelStatus; qr?: ReactNode }) {
  const [confirmState, confirmAction, confirming] = useActionState(confirmMfaEnrollmentAction, initialMfaFormState);
  const [regenState, regenAction, regenerating] = useActionState(regenerateRecoveryCodesAction, initialMfaFormState);
  const [disableState, disableAction, disabling] = useActionState(disableMfaAction, initialMfaFormState);
  const codes = regenState.recoveryCodes ?? confirmState.recoveryCodes;

  return (
    <div className="space-y-6">
      {codes ? <RecoveryCodes codes={codes} /> : null}

      {!status.enabled && !status.pending ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold">Ativar a verificação em dois passos</h2>
          <p className="mt-1 text-sm text-slate-600">
            Precisas de uma app de autenticação (por exemplo Google Authenticator, Microsoft Authenticator, 1Password ou Bitwarden).
          </p>
          <form action={startMfaEnrollmentAction} className="mt-4">
            <button className={button}>Configurar 2FA</button>
          </form>
        </section>
      ) : null}

      {!status.enabled && status.pending ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold">1. Adiciona a conta na app</h2>
          <div className="mt-3 flex flex-wrap items-start gap-6">
            {qr ? <div className="shrink-0">{qr}</div> : null}
            <div className="min-w-0 flex-1 text-sm text-slate-600">
              <p>Na app de autenticação, escolhe “adicionar conta” e lê o código QR com a câmara.</p>
              <p className="mt-3">
                Sem câmara? Escolhe “introduzir chave manualmente” e usa esta chave (tipo: baseada no tempo, 6 dígitos):
              </p>
              <code data-testid="totp-secret" className="mt-2 block rounded bg-slate-100 px-3 py-2 font-mono text-lg tracking-wider text-slate-900 select-all">
                {status.pending.secretDisplay}
              </code>
              <p className="mt-3">
                Neste dispositivo, com a app instalada: <a href={status.pending.uri} className="underline">abrir na app</a>.
              </p>
              <p className="mt-3 text-xs text-slate-500">
                O código QR e a chave dão acesso ao segundo fator: não os partilhes nem tires capturas de ecrã.
              </p>
            </div>
          </div>
          <h2 className="mt-6 font-semibold">2. Confirma com o código da app</h2>
          {confirmState.error ? <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{confirmState.error}</div> : null}
          <form action={confirmAction} className="mt-3 flex flex-wrap items-end gap-3">
            <label className="block text-sm font-medium">
              Código de 6 dígitos
              <input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className={input} />
            </label>
            <button disabled={confirming} className={button}>{confirming ? "A confirmar…" : "Ativar 2FA"}</button>
          </form>
          <form action={startMfaEnrollmentAction} className="mt-3">
            <button className="text-sm text-slate-600 underline">Gerar outra chave</button>
          </form>
        </section>
      ) : null}

      {status.enabled ? (
        <>
          <section className="rounded-xl border border-emerald-200 bg-white p-5">
            <h2 className="font-semibold text-emerald-800">2FA ativo</h2>
            <p className="mt-1 text-sm text-slate-600">
              Ativado em {status.enabledAt ?? "—"} · {status.recoveryCodesRemaining} código(s) de recuperação por usar.
            </p>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold">Novos códigos de recuperação</h2>
            <p className="mt-1 text-sm text-slate-600">Invalida os códigos anteriores. Confirma com um código atual da app.</p>
            {regenState.error ? <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{regenState.error}</div> : null}
            <form action={regenAction} className="mt-3 flex flex-wrap items-end gap-3">
              <label className="block text-sm font-medium">
                Código da app
                <input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className={input} />
              </label>
              <button disabled={regenerating} className={button}>{regenerating ? "A gerar…" : "Gerar novos códigos"}</button>
            </form>
          </section>
          {!status.required ? (
            <section className="rounded-xl border border-red-200 bg-white p-5">
              <h2 className="font-semibold text-red-800">Desativar 2FA</h2>
              {disableState.error ? <div role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{disableState.error}</div> : null}
              <form action={disableAction} className="mt-3 flex flex-wrap items-end gap-3">
                <label className="block text-sm font-medium">
                  Palavra-passe
                  <input name="password" type="password" required autoComplete="current-password" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
                </label>
                <label className="block text-sm font-medium">
                  Código da app
                  <input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className={input} />
                </label>
                <button disabled={disabling} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
                  Desativar
                </button>
              </form>
            </section>
          ) : (
            <p className="text-sm text-slate-500">
              O 2FA é obrigatório para administradores. Se perderes o telemóvel e os códigos, pede a outro administrador que o reponha.
            </p>
          )}
        </>
      ) : null}
      {disableState.done && !status.enabled ? <p role="status" className="text-sm text-emerald-800">2FA desativado.</p> : null}
    </div>
  );
}
