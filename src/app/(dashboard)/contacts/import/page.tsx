import Link from "next/link";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { ImportWizard } from "./import-wizard";

export default async function ImportContactsPage() {
  const user = await requireUser();
  const allowed = can(user.role, "contacts:import");
  const lists = allowed
    ? await prisma.contactList.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } })
    : [];

  return (
    <div className="max-w-5xl">
      <Link href="/contacts" className="text-sm text-slate-600 hover:underline">← Contactos</Link>
      <h1 className="mt-2 text-3xl font-bold">Importar contactos (CSV)</h1>
      <p className="mt-2 text-slate-600">
        A presença de um número no ficheiro nunca é considerada consentimento. Formato recomendado:{" "}
        <code className="rounded bg-slate-100 px-1">name,phone,consent_status,consent_source</code>
      </p>
      {allowed ? (
        <ImportWizard lists={lists} />
      ) : (
        <p className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          O teu perfil não permite importar contactos.
        </p>
      )}
    </div>
  );
}
