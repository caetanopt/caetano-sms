"use client";

import { useActionState } from "react";
import { resetPasswordAction } from "@/app/actions/users";
import { initialUserSecretFormState } from "@/features/users/user-form-state";
import { TemporaryPassword } from "./temporary-password";

export function ResetPasswordForm({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(resetPasswordAction.bind(null, userId), initialUserSecretFormState);
  return (
    <div className="mt-3 space-y-3">
      {state.temporaryPassword ? <TemporaryPassword password={state.temporaryPassword} /> : null}
      {state.error ? <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</div> : null}
      <form action={formAction} className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="confirm" required /> Confirmo: gerar nova palavra-passe e terminar as sessões abertas
        </label>
        <button disabled={pending} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {pending ? "A repor…" : "Repor palavra-passe"}
        </button>
      </form>
    </div>
  );
}
