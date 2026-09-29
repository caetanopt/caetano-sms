"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/app/actions/users";
import { initialPasswordChangeFormState } from "@/features/users/user-form-state";

const input = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

export function ChangePasswordForm({ minLength }: { minLength: number }) {
  const [state, formAction, pending] = useActionState(changePasswordAction, initialPasswordChangeFormState);
  return (
    <form action={formAction} className="mt-6 space-y-4">
      {state.error ? <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</div> : null}
      <label className="block text-sm font-medium">
        Palavra-passe atual
        <input name="currentPassword" type="password" required autoComplete="current-password" className={input} />
      </label>
      <label className="block text-sm font-medium">
        Nova palavra-passe
        <input name="newPassword" type="password" required minLength={minLength} maxLength={200} autoComplete="new-password" aria-describedby="password-help" className={input} />
        <span id="password-help" className="mt-1 block text-xs font-normal text-slate-500">
          Mínimo {minLength} caracteres. Uma frase longa é mais segura do que símbolos. Não pode conter o email.
        </span>
      </label>
      <label className="block text-sm font-medium">
        Confirmar nova palavra-passe
        <input name="confirmPassword" type="password" required minLength={minLength} maxLength={200} autoComplete="new-password" className={input} />
      </label>
      <button disabled={pending} className="w-full rounded-lg bg-slate-900 px-4 py-2.5 font-semibold text-white disabled:opacity-60">
        {pending ? "A guardar…" : "Alterar palavra-passe"}
      </button>
    </form>
  );
}
