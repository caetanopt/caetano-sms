"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  campaignProgressAction,
  cancelCampaignAction,
  pauseCampaignAction,
  processCampaignStepAction,
  resumeCampaignAction,
  revertCampaignAction,
} from "@/app/actions/campaigns";
import { campaignStatusLabel, RECIPIENT_STATUS_LABELS } from "@/features/campaigns/labels";
import type { CampaignProgress } from "@/features/campaigns/progress";
import { AUTOSTART_KEY } from "./confirm-form";

const ACTIVE = ["READY", "SENDING"];

function sleep(ms: number, signal: { aborted: boolean }) {
  return new Promise<void>((resolve) => {
    const started = Date.now();
    const tick = () => (signal.aborted || Date.now() - started >= ms ? resolve() : setTimeout(tick, 100));
    tick();
  });
}

export function CampaignRunner({
  campaignId,
  initial,
  canSend,
  canRevert,
}: {
  campaignId: string;
  initial: CampaignProgress;
  canSend: boolean;
  /** Nenhum SMS tentado: permite voltar a rascunho. */
  canRevert: boolean;
}) {
  const router = useRouter();
  const [progress, setProgress] = useState(initial);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const loop = useRef<{ aborted: boolean } | null>(null);

  const active = ACTIVE.includes(progress.status);

  const stopLoop = useCallback(() => {
    if (loop.current) loop.current.aborted = true;
    loop.current = null;
    setRunning(false);
  }, []);

  const run = useCallback(async () => {
    if (loop.current) return; // no máximo um loop por página
    const signal = { aborted: false };
    loop.current = signal;
    setRunning(true);
    setNotice(null);
    try {
      const resumed = await resumeCampaignAction(campaignId);
      if (!resumed.ok) {
        setNotice(resumed.message);
        return;
      }
      while (!signal.aborted) {
        const result = await processCampaignStepAction(campaignId);
        if (signal.aborted) break;
        // "forbidden" não traz progresso real: manter o último conhecido.
        if (result.state !== "forbidden") setProgress(result);
        if (result.message) setNotice(result.message);
        if (result.state === "finished" || result.state === "paused" || result.state === "forbidden") {
          if (result.state === "finished") router.refresh();
          return;
        }
        await sleep(Math.max(300, result.retryAfterMs), signal);
      }
    } catch {
      setNotice("Ligação perdida — o envio parou. Verifica o estado e clica em Continuar envio.");
    } finally {
      if (loop.current === signal) stopLoop();
    }
  }, [campaignId, router, stopLoop]);

  // Início automático apenas logo após "Confirmar e enviar" neste separador (uso único).
  useEffect(() => {
    let flagged = false;
    try {
      flagged = sessionStorage.getItem(AUTOSTART_KEY(campaignId)) === "1";
      sessionStorage.removeItem(AUTOSTART_KEY(campaignId));
    } catch {
      flagged = false;
    }
    const timer = flagged && canSend && ACTIVE.includes(initial.status) ? setTimeout(() => void run(), 0) : null;
    return () => {
      if (timer) clearTimeout(timer);
      if (loop.current) loop.current.aborted = true;
      loop.current = null;
    };
  }, [campaignId, canSend, initial.status, run]);

  // Sem loop nesta página: apenas acompanhar o progresso (nunca envia).
  useEffect(() => {
    if (running || !active) return;
    const timer = setInterval(async () => {
      try {
        const result = await campaignProgressAction(campaignId);
        if (result.state === "forbidden") return;
        setProgress(result);
        if (!ACTIVE.includes(result.status)) router.refresh();
      } catch {
        /* rede indisponível: tenta no próximo ciclo */
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, [running, active, campaignId, router]);

  async function refreshProgress() {
    const result = await campaignProgressAction(campaignId);
    if (result.state !== "forbidden") setProgress(result);
  }

  async function pause() {
    stopLoop();
    setNotice("A parar… o envio em curso termina primeiro.");
    try {
      const result = await pauseCampaignAction(campaignId);
      setNotice(result.ok ? "Envio em pausa." : result.message);
      await refreshProgress();
    } catch {
      setNotice("Não foi possível pausar (ligação perdida). Tenta de novo.");
    }
  }

  async function cancel() {
    stopLoop();
    setNotice("A cancelar… o envio em curso termina primeiro.");
    try {
      const result = await cancelCampaignAction(campaignId);
      setNotice(result.ok ? "Campanha cancelada. Os destinatários por enviar não receberão SMS." : result.message);
      await refreshProgress();
    } catch {
      setNotice("Não foi possível cancelar (ligação perdida). Tenta de novo.");
    }
    setConfirmCancel(false);
    router.refresh();
  }

  async function revert() {
    stopLoop();
    try {
      const result = await revertCampaignAction(campaignId);
      if (!result.ok) setNotice(result.message);
    } catch {
      setNotice("Não foi possível voltar a rascunho (ligação perdida).");
    }
    router.refresh();
  }

  const { counts } = progress;
  const toSend = counts.PENDING + counts.PROCESSING + counts.ACCEPTED + counts.FAILED + counts.UNKNOWN;
  const done = counts.ACCEPTED + counts.FAILED + counts.UNKNOWN;
  const percent = toSend > 0 ? Math.round((done / toSend) * 100) : 0;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6" aria-label="Progresso da campanha">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {campaignStatusLabel(progress.status)}
          {progress.paused && active ? " · em pausa" : ""}
          {running ? " · a enviar…" : ""}
        </h2>
        <span className="text-sm text-slate-600">{done} de {toSend} processados</span>
      </div>
      <div className="mt-3 h-3 w-full overflow-hidden rounded bg-slate-100" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-emerald-600 transition-all" style={{ width: `${percent}%` }} />
      </div>

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
        {(Object.keys(counts) as Array<keyof typeof counts>).map((status) => (
          <div key={status} className="rounded-lg bg-slate-50 p-2">
            <dt className="text-xs text-slate-500">{RECIPIENT_STATUS_LABELS[status]}</dt>
            <dd className="text-lg font-bold" data-status={status}>{counts[status]}</dd>
          </div>
        ))}
      </dl>

      {progress.lastError ? (
        <div role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {progress.lastError}
        </div>
      ) : null}
      {notice ? <p role="status" className="mt-3 text-sm text-slate-700">{notice}</p> : null}
      {counts.UNKNOWN > 0 ? (
        <p className="mt-3 text-sm text-amber-800">
          {counts.UNKNOWN} mensagem(ns) com resultado incerto: podem ter sido enviadas. Não reenviar sem verificar.
        </p>
      ) : null}

      {canSend && active ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          {running ? (
            <button onClick={pause} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold">
              Pausar
            </button>
          ) : (
            <button onClick={() => void run()} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
              {progress.paused ? "Retomar envio" : progress.status === "READY" ? "Iniciar envio" : "Continuar envio"}
            </button>
          )}
          {canRevert && !running ? (
            <button onClick={revert} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold">
              Voltar a rascunho (rever de novo)
            </button>
          ) : null}
          {confirmCancel ? (
            <span className="flex items-center gap-2 text-sm">
              Cancelar definitivamente?
              <button onClick={cancel} className="rounded-lg bg-red-700 px-3 py-2 font-semibold text-white">Sim, cancelar</button>
              <button onClick={() => setConfirmCancel(false)} className="underline">Não</button>
            </span>
          ) : (
            <button onClick={() => setConfirmCancel(true)} className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-800">
              Cancelar campanha
            </button>
          )}
          {!running ? (
            <span className="text-xs text-slate-500">Depois de iniciado, o envio avança com esta página aberta ou com o worker (pnpm worker:campaigns).</span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
