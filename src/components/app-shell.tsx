import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { getSmsRuntimeConfig } from "@/lib/sms/config";
import { Wordmark } from "./brand/wordmark";
import { Icon } from "./icons";
import { NavLinks, type NavItem } from "./nav-links";

const ROLE_LABELS = { ADMIN: "Administrador", OPERATOR: "Operador", VIEWER: "Leitura" } as const;

function readMode() {
  try {
    return getSmsRuntimeConfig().mode;
  } catch {
    return null;
  }
}

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const mode = readMode();

  const items: NavItem[] = [
    { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
    { href: "/send", label: "Enviar SMS", icon: "send" },
    { href: "/contacts", label: "Contactos", icon: "contacts" },
    { href: "/lists", label: "Listas", icon: "lists" },
    { href: "/templates", label: "Templates", icon: "templates" },
    { href: "/campaigns", label: "Campanhas", icon: "campaigns" },
    { href: "/messages", label: "Histórico", icon: "history" },
  ];
  if (can(user.role, "users:manage")) items.push({ href: "/users", label: "Utilizadores", icon: "users" });
  if (can(user.role, "observability:view")) items.push({ href: "/observability", label: "Observabilidade", icon: "observability" });

  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <div className="min-h-screen lg:pl-72">
      <aside className="relative z-20 overflow-hidden bg-brand-deep text-white lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-72 lg:flex-col">
        {/* Brilho de fundo subtil (azul cyan da marca). */}
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-cyan/25 blur-3xl animate-float" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-32 -left-20 h-72 w-72 rounded-full bg-brand-cyan/10 blur-3xl" />

        <div className="relative flex items-center justify-between gap-4 px-6 pb-4 pt-6 lg:block">
          <Link href="/dashboard" className="inline-flex flex-col gap-2 rounded-lg p-1 -m-1" aria-label="Caetano — Plataforma SMS, ir para o dashboard">
            <Wordmark color="white" height={26} title="Caetano" />
            <span className="text-[0.68rem] font-semibold uppercase tracking-[0.28em] text-brand-cyan-60">Plataforma SMS</span>
          </Link>
          <ModePill mode={mode} className="lg:mt-5" />
        </div>

        <nav aria-label="Principal" className="relative px-3 pb-3 lg:flex-1 lg:overflow-y-auto lg:pt-4">
          <NavLinks items={items} />
        </nav>

        <div className="relative hidden border-t border-white/10 p-4 lg:block">
          <UserCard name={user.name} role={ROLE_LABELS[user.role]} initials={initials} />
        </div>
      </aside>

      <header className="sticky top-0 z-10 border-b border-slate-200/70 bg-white/75 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-end gap-2 px-4 py-3 text-sm sm:gap-3 sm:px-6">
          <div className="mr-auto hidden text-xs font-medium uppercase tracking-[0.2em] text-slate-500 lg:block">
            Retalho automóvel · Grupo Salvador Caetano
          </div>
          <div className="mr-auto flex min-w-0 items-center gap-2 lg:hidden">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-deep text-xs font-bold text-white" aria-hidden="true">{initials}</span>
            <div className="min-w-0 leading-tight">
              <div className="truncate font-medium text-brand-deep">{user.name}</div>
              <div className="text-xs text-slate-500">{ROLE_LABELS[user.role]}</div>
            </div>
          </div>
          <div className="hidden text-right leading-tight lg:block">
            <div className="font-semibold text-brand-deep">{user.name}</div>
            <div className="text-xs text-slate-500">{ROLE_LABELS[user.role]}</div>
          </div>
          <span className="hidden h-6 w-px bg-slate-200 lg:block" aria-hidden="true" />
          <Link href="/account/password" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-brand-deep">
            <Icon name="key" className="h-4 w-4" />
            <span className="sr-only sm:not-sr-only">Palavra-passe</span>
          </Link>
          <Link href="/account/mfa" className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-brand-deep">
            <Icon name="shield" className="h-4 w-4" />
            <span className="sr-only sm:not-sr-only">2FA</span>
          </Link>
          <form action={logoutAction}>
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 font-medium text-brand-deep hover:border-brand-deep/30 hover:bg-slate-50">
              <Icon name="logout" className="h-4 w-4" />
              <span className="sr-only sm:not-sr-only">Sair</span>
            </button>
          </form>
        </div>
      </header>

      <main className="page-enter mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:py-10">{children}</main>

      <footer className="mx-auto max-w-7xl px-6 pb-8 text-xs text-slate-400">
        <span lang="en" className="font-medium text-brand-claim">Your favourite way to move</span>
        <span aria-hidden="true"> · </span>
        Datas e horas em Europe/Lisbon
      </footer>
    </div>
  );
}

function ModePill({ mode, className = "" }: { mode: "TEST" | "PRODUCTION" | null; className?: string }) {
  if (!mode) return null;
  const test = mode === "TEST";
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-[0.7rem] font-semibold uppercase tracking-wider ${
        test ? "bg-brand-yellow/15 text-brand-yellow ring-1 ring-brand-yellow/40" : "bg-brand-eco/15 text-brand-eco ring-1 ring-brand-eco/40"
      } ${className}`}
      title={test ? "Nenhum SMS real é enviado" : "Os SMS são enviados através da AWS"}
    >
      <span className={`relative flex h-2 w-2`}>
        <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${test ? "bg-brand-yellow" : "bg-brand-eco"}`} />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${test ? "bg-brand-yellow" : "bg-brand-eco"}`} />
      </span>
      {test ? "Modo de teste" : "Produção"}
    </span>
  );
}

function UserCard({ name, role, initials }: { name: string; role: string; initials: string }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-white/6 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand-cyan to-brand-deep-80 text-sm font-bold">{initials}</span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold">{name}</div>
        <div className="text-xs text-white/60">{role}</div>
      </div>
    </div>
  );
}
