"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { urlWithoutFlashParams } from "@/lib/http/flash-params";

function Consume() {
  const searchParams = useSearchParams();
  useEffect(() => {
    // A mensagem já está no ecrã (renderizada no servidor); retirá-la do URL evita que reapareça
    // num refresh do router, num reload ou num link partilhado. O Next.js sincroniza o router com
    // `history.replaceState` sem novo pedido ao servidor.
    const next = urlWithoutFlashParams(window.location.href);
    if (next) window.history.replaceState(null, "", next);
  }, [searchParams]);
  return null;
}

/**
 * Consome as mensagens de feedback do URL depois de mostradas: ficam visíveis até à próxima
 * navegação ou atualização da página, e não "colam" a estados seguintes (ex.: "Rascunho criado"
 * numa campanha já concluída).
 */
export function ConsumeFlashParams() {
  return (
    <Suspense fallback={null}>
      <Consume />
    </Suspense>
  );
}
