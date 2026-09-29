import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { requireUser } from "@/lib/auth/session";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="font-bold">SMS AWS</Link>
            <nav className="flex gap-4 text-sm text-slate-600">
              <Link href="/dashboard" className="hover:text-slate-950">Dashboard</Link>
              <Link href="/send" className="hover:text-slate-950">Enviar SMS</Link>
              <Link href="/contacts" className="hover:text-slate-950">Contactos</Link>
              <Link href="/lists" className="hover:text-slate-950">Listas</Link>
              <Link href="/templates" className="hover:text-slate-950">Templates</Link>
              <Link href="/campaigns" className="hover:text-slate-950">Campanhas</Link>
              <Link href="/messages" className="hover:text-slate-950">Histórico</Link>
            </nav>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <div className="text-right">
              <div className="font-medium">{user.name}</div>
              <div className="text-xs text-slate-500">{user.role}</div>
            </div>
            <form action={logoutAction}>
              <button className="rounded-lg border border-slate-300 px-3 py-2 hover:bg-slate-50">Sair</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-6">{children}</main>
    </div>
  );
}
