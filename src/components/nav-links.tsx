"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icons";

export type NavItem = { href: string; label: string; icon: IconName };

/** Navegação principal com indicador animado do item ativo (aria-current). */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href} className="shrink-0">
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 ${
                active ? "bg-white/12 text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]" : "text-white/70 hover:bg-white/6 hover:text-white"
              }`}
            >
              <span
                aria-hidden="true"
                className={`absolute left-0 top-1/2 hidden h-6 w-1 -translate-y-1/2 rounded-r-full bg-brand-cyan transition-all duration-300 lg:block ${
                  active ? "opacity-100" : "scale-y-0 opacity-0"
                }`}
              />
              <Icon
                name={item.icon}
                className={`h-5 w-5 transition-transform duration-200 group-hover:scale-110 ${active ? "text-brand-cyan" : "text-white/60 group-hover:text-white"}`}
              />
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
