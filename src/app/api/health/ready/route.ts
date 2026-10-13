import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

/** Prontidão para load balancers: verifica a base de dados. Nunca envia SMS nem expõe detalhes. */
export async function GET() {
  try {
    await prisma.user.findFirst({ select: { id: true } });
    return NextResponse.json({ status: "ok" });
  } catch {
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
