"use client";

import { useActionState } from "react";
import { verifyMfaLoginAction } from "@/app/actions/mfa";
import { initialMfaFormState } from "@/features/auth/mfa-form-state";

export function MfaLoginForm() {
  const [state, formAction, pending] = useActionState(verifyMfaLoginAction, initialMfaFormState);
  return (
    <form action={formAction} className="mt-6 space-y-4">
      {state.error ? <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</div> : null}
      <label className="block text-sm font-medium">
        Código de verificação
        <input
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode="text"
          maxLength={20}
          aria-describedby="code-help"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono tracking-widest"
        />
        <span id="code-help" className="mt-1 block text-xs font-normal text-slate-500">
          6 dígitos da app de autenticação, ou um código de recuperação (ex.: ABCDE-FGHJK).
        </span>
      </label>
      <button disabled={pending} className="w-full rounded-lg bg-slate-900 px-4 py-2.5 font-semibold text-white disabled:opacity-60">
        {pending ? "A verificar…" : "Verificar"}
      </button>
    </form>
  );
}
