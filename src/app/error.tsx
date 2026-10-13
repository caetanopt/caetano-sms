"use client";

import Link from "next/link";
import { StatusScreen, primaryAction, secondaryAction } from "@/components/status-screen";

/** Erro inesperado: mensagem segura, sem detalhes internos (§20, §28); só a referência do registo. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <StatusScreen
      code="Erro inesperado"
      title="Algo correu mal"
      actions={
        <>
          <button type="button" onClick={reset} className={primaryAction}>Tentar novamente</button>
          <Link href="/dashboard" className={secondaryAction}>Voltar ao dashboard</Link>
        </>
      }
    >
      <p>Não foi possível concluir o pedido. Nenhuma ação foi repetida automaticamente.</p>
      {error.digest ? <p className="mt-2 text-sm text-white/60">Referência: <span className="font-mono">{error.digest}</span></p> : null}
    </StatusScreen>
  );
}
