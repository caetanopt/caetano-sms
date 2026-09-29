"use client";

import { useActionState } from "react";
import { createUserAction } from "@/app/actions/users";
import { initialUserSecretFormState, ROLE_LABELS } from "@/features/users/user-form-state";
import { TemporaryPassword } from "./temporary-password";

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(createUserAction, initialUserSecretFormState);
  return (
    <div className="space-y-4">
      {state.temporaryPassword ? <TemporaryPassword password={state.temporaryPassword} email={state.email} /> : null}
      {state.error ? <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{state.error}</div> : null}
      {/* key: após erro, remonta com os valores submetidos (o React limpa o formulário) */}
      <form key={JSON.stringify(state.values ?? {})} action={formAction} className="grid gap-4 md:grid-cols-4 md:items-end">
        <label className="block text-sm font-medium">
          Nome
          <input name="name" required maxLength={120} defaultValue={state.values?.name} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="block text-sm font-medium">
          Email
          <input name="email" type="email" required maxLength={200} autoComplete="off" defaultValue={state.values?.email} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="block text-sm font-medium">
          Perfil
          <select name="role" required defaultValue={state.values?.role ?? ""} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            <option value="" disabled>Seleciona…</option>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <button disabled={pending} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {pending ? "A criar…" : "Criar utilizador"}
        </button>
      </form>
    </div>
  );
}
