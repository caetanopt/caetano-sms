import Link from "next/link";
import { redirect } from "next/navigation";
import { Feedback } from "@/components/feedback";
import { CreateUserForm } from "@/components/users/create-user-form";
import { ROLE_LABELS } from "@/features/users/user-form-state";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";

const dateTime = (value: Date | null) => (value ? value.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" }) : "—");

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const user = await requireUser();
  if (!can(user.role, "users:manage")) redirect("/dashboard");
  const params = await searchParams;
  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    select: { id: true, name: true, email: true, role: true, isActive: true, mustChangePassword: true, lastLoginAt: true, totpEnabledAt: true },
  });

  return (
    <div>
      <h1 className="text-3xl font-bold">Utilizadores</h1>
      <p className="mt-2 text-slate-600">
        Não existe registo público: só administradores criam contas. Contas desativadas mantêm o histórico e a auditoria.
      </p>
      <Feedback success={params.success} error={params.error} />

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-4 font-semibold">Novo utilizador</h2>
        <CreateUserForm />
      </section>

      <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Perfil</th>
              <th className="px-4 py-3">Estado</th>
              <th className="px-4 py-3">2FA</th>
              <th className="px-4 py-3">Último início de sessão</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="px-4 py-3 font-medium">
                  <Link href={`/users/${row.id}`} className="hover:underline">{row.name}</Link>
                  {row.id === user.id ? <span className="ml-2 text-xs text-slate-500">(tu)</span> : null}
                </td>
                <td className="px-4 py-3">{row.email}</td>
                <td className="px-4 py-3">{ROLE_LABELS[row.role]}</td>
                <td className="px-4 py-3">
                  {row.isActive ? (
                    row.mustChangePassword ? <span className="text-amber-700">Palavra-passe temporária</span> : "Ativo"
                  ) : (
                    <span className="text-slate-500">Desativado</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {row.totpEnabledAt ? "Ativo" : row.role === "ADMIN" ? <span className="text-amber-700">Por configurar</span> : "—"}
                </td>
                <td className="px-4 py-3 text-slate-500">{dateTime(row.lastLoginAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
