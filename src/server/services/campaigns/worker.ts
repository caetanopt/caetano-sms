import { prisma } from "@/lib/db/prisma";
import { processCampaignStep, reconcileCampaign, type EngineDeps } from "./engine";

/**
 * Uma passagem do worker: avança campanhas JÁ INICIADAS por um operador (SENDING, sem
 * pausa) e reconcilia canceladas com envios presos. Nunca inicia uma campanha READY:
 * o início é sempre uma ação explícita e auditada (CLAUDE.md §40 "NO silent bulk send").
 * Vários workers (ou worker + página) podem correr em simultâneo: o lease por campanha e a
 * chave de idempotência impedem envios duplicados.
 */
export async function runWorkerOnce(deps: EngineDeps, options: { maxCampaigns?: number } = {}) {
  const [sending, cancelled] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: "SENDING", pausedAt: null },
      orderBy: { updatedAt: "asc" },
      take: options.maxCampaigns ?? 20,
      select: { id: true },
    }),
    prisma.campaign.findMany({ where: { status: "CANCELLED", finishedAt: null }, take: 20, select: { id: true } }),
  ]);

  for (const campaign of cancelled) await reconcileCampaign(campaign.id, deps);

  let nextWaitMs = 5_000;
  let processed = 0;
  for (const campaign of sending) {
    const result = await processCampaignStep(campaign.id, deps);
    processed += 1;
    if (result.state === "continue") nextWaitMs = Math.min(nextWaitMs, 500);
    else if (result.state === "wait" || result.state === "busy") nextWaitMs = Math.min(nextWaitMs, Math.max(500, result.waitMs));
  }
  return { processed, nextWaitMs: sending.length === 0 ? 5_000 : nextWaitMs };
}
