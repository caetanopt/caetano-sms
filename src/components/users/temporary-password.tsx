"use client";

import { useState } from "react";

/** Mostra a palavra-passe temporária uma única vez (não é guardada nem enviada por email). */
export function TemporaryPassword({ password, email }: { password: string; email?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">Palavra-passe temporária{email ? ` para ${email}` : ""}</p>
      <p className="mt-1">
        Só é mostrada agora. Entrega-a por um canal seguro; o utilizador terá de a alterar no primeiro início de sessão.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <code data-testid="temporary-password" className="rounded bg-white px-3 py-2 font-mono text-base select-all">
          {password}
        </code>
        <button type="button" onClick={copy} className="rounded-lg border border-amber-400 px-3 py-2 hover:bg-amber-100">
          {copied ? "Copiada" : "Copiar"}
        </button>
      </div>
    </div>
  );
}
