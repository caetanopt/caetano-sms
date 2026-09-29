import { NextResponse } from "next/server";
import { toPrometheus } from "@/features/observability/metrics";
import { bearerMatches, getMetricsConfig } from "@/lib/observability/config";
import { collectOperationalMetrics } from "@/server/services/observability";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Métricas no formato Prometheus (CLAUDE.md §32). Sem PII. Desativado (404) sem
 * METRICS_TOKEN; exige `Authorization: Bearer <METRICS_TOKEN>`.
 */
export async function GET(request: Request) {
  let token: string | null;
  try {
    token = getMetricsConfig().token;
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (!token) return new NextResponse(null, { status: 404, headers: NO_STORE });
  if (!bearerMatches(request.headers.get("authorization"), token)) {
    return new NextResponse(null, { status: 401, headers: { ...NO_STORE, "WWW-Authenticate": "Bearer" } });
  }
  try {
    const body = toPrometheus(await collectOperationalMetrics());
    return new NextResponse(body, { headers: { ...NO_STORE, "Content-Type": "text/plain; version=0.0.4; charset=utf-8" } });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503, headers: NO_STORE });
  }
}
