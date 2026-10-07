import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { resetUserMfaAction, updateUserAction } from "@/app/actions/users";
import { Feedback } from "@/components/feedback";
import { ResetPasswordForm } from "@/components/users/reset-password-form";
import { getCampaignLimits } from "@/features/campaigns/limits";
import { describeQuota } from "@/features/rate-limit/quota";
import { ROLE_LABELS } from "@/features/users/user-form-state";
import { getUserQuotaSnapshot } from "@/server/services/send-rate";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { readFlash } from "@/lib/http/flash";

const dateTime = (value: Date | null) => (value ? value.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" }) : "—");
const input = "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2";

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ success?: string; error?: string }>;
}) {
  const actor = await requireUser();
  if (!can(actor.role, "users:manage")) redirect("/dashboard");
  const [{ id }, feedback] = await Promise.all([params, searchParams]);
  const flash = readFlash(feedback);
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true, name: true, email: true, role: true, isActive: true, mustChangePassword: true,
      lastLoginAt: true, passwordChangedAt: true, createdAt: true, totpEnabledAt: true, totpPendingSecretEnc: true,
      dailyPartsLimit: true,
    },
  });
  if (!user) notFound();
  const self = user.id === actor.id;
  // Quota diária: defeito da aplicação e uso de hoje (omitidos se a configuração for inválida).
  let defaultDailyParts: number | null = null;
  let quotaToday: string | null = null;
  try {
    defaultDailyParts = getCampaignLimits().userDailyParts;
    const snapshot = await getUserQuotaSnapshot(user.id, defaultDailyParts);
    if (snapshot) quotaToday = describeQuota(snapshot) + (snapshot.used > snapshot.limit ? " — acima do limite atual" : "");
  } catch {
    defaultDailyParts = null;
  }
  // Ações sobre esta conta e ações feitas por ela (sem metadados: podem conter dados de contactos).
  const audit = await prisma.auditLog.findMany({
    where: { OR: [{ entityType: "User", entityId: user.id }, { userId: user.id }] },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, action: true, entityType: true, createdAt: true, user: { select: { name: true } } },
  });

  return (
    <div className="max-w-4xl">
      <Link href="/users" className="text-sm text-slate-600 hover:underline">← Utilizadores</Link>
      <h1 className="mt-2 text-3xl font-bold">{user.name}</h1>
      <p className="mt-1 text-sm text-slate-600">
        {user.email} · criado em {dateTime(user.createdAt)} · último início de sessão {dateTime(user.lastLoginAt)} ·
        palavra-passe alterada {dateTime(user.passwordChangedAt)}
      </p>
      <Feedback success={flash.success} error={flash.error} />

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Dados e perfil</h2>
        {self ? <p className="mt-1 text-sm text-slate-500">Não podes alterar o teu próprio perfil, a tua quota diária nem desativar a tua conta (pede a outro administrador).</p> : null}
        <form action={updateUserAction.bind(null, user.id)} className="mt-4 grid gap-4 md:grid-cols-3 md:items-end">
          <label className="block text-sm font-medium">
            Nome
            <input name="name" required maxLength={120} defaultValue={user.name} className={input} />
          </label>
          <label className="block text-sm font-medium">
            Perfil
            {self ? <input type="hidden" name="role" value={user.role} /> : null}
            <select name={self ? undefined : "role"} defaultValue={user.role} disabled={self} className={input}>
              {Object.entries(ROLE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Estado
            {self ? <input type="hidden" name="isActive" value="true" /> : null}
            <select name={self ? undefined : "isActive"} defaultValue={String(user.isActive)} disabled={self} className={input}>
              <option value="true">Ativo</option>
              <option value="false">Desativado</option>
            </select>
          </label>
          <label className="block text-sm font-medium md:col-span-3">
            Quota diária (partes SMS)
            {self ? <input type="hidden" name="dailyPartsLimit" value={user.dailyPartsLimit ?? ""} /> : null}
            <input
              type="number"
              name={self ? undefined : "dailyPartsLimit"}
              min={0}
              max={1_000_000}
              step={1}
              disabled={self}
              defaultValue={user.dailyPartsLimit ?? ""}
              placeholder={defaultDailyParts !== null ? `defeito: ${defaultDailyParts}` : "defeito da aplicação"}
              className={`${input} md:w-64`}
            />
            <span className="mt-1 block text-xs font-normal text-slate-500">
              Vazio = defeito da aplicação{defaultDailyParts !== null ? ` (${defaultDailyParts})` : ""}. 0 = sem envios, sem desativar a
              conta. Conta envios individuais e campanhas que este utilizador confirmar (partes estimadas), incluindo em modo de
              teste. Aplica-se de imediato.
              {quotaToday ? ` Hoje: ${quotaToday}.` : ""}
            </span>
          </label>
          <p className="text-xs text-slate-500 md:col-span-2">
            Mudar o perfil ou desativar termina de imediato as sessões abertas deste utilizador. Desativar pausa as campanhas que
            confirmou.
          </p>
          <button className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white">Guardar</button>
        </form>
      </section>

      {!self ? (
        <section className="mt-6 rounded-xl border border-red-200 bg-white p-5">
          <h2 className="font-semibold text-red-800">Repor palavra-passe</h2>
          <p className="mt-1 text-sm text-slate-600">
            Gera uma palavra-passe temporária de utilização única. {user.mustChangePassword ? "Este utilizador ainda tem uma palavra-passe temporária por alterar." : ""}
          </p>
          <ResetPasswordForm userId={user.id} />
        </section>
      ) : (
        <p className="mt-6 text-sm">
          Para alterar a tua palavra-passe usa <Link href="/account/password" className="underline">Alterar palavra-passe</Link>.
        </p>
      )}

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Verificação em dois passos (2FA)</h2>
        <p className="mt-1 text-sm text-slate-600">
          {user.totpEnabledAt
            ? `Ativo desde ${dateTime(user.totpEnabledAt)}.`
            : user.totpPendingSecretEnc
              ? "Configuração iniciada, por confirmar."
              : user.role === "ADMIN"
                ? "Por configurar: será pedido no próximo início de sessão."
                : "Não configurado (opcional para este perfil)."}
        </p>
        {!self && (user.totpEnabledAt || user.totpPendingSecretEnc) ? (
          <form action={resetUserMfaAction.bind(null, user.id)} className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="confirm" required /> Confirmo a identidade do utilizador (ex.: telemóvel perdido)
            </label>
            <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white">Repor 2FA</button>
          </form>
        ) : null}
      </section>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="font-semibold">Auditoria recente</h2>
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {audit.map((entry) => (
            <li key={entry.id} className="flex flex-wrap justify-between gap-2 py-2">
              <span className="font-mono text-xs">{entry.action}</span>
              <span className="text-slate-500">
                {entry.entityType} · por {entry.user?.name ?? "sistema"} · {dateTime(entry.createdAt)}
              </span>
            </li>
          ))}
          {audit.length === 0 ? <li className="py-2 text-slate-500">Sem registos.</li> : null}
        </ul>
      </section>
    </div>
  );
}
