import Link from "next/link";

export function Pagination({
  page,
  pageSize,
  total,
  href,
}: {
  page: number;
  pageSize: number;
  total: number;
  /** Constrói o URL de uma página mantendo os filtros. */
  href: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <p className="mt-3 text-sm text-slate-500">{total} resultado(s)</p>;
  return (
    <nav aria-label="Paginação" className="mt-3 flex items-center gap-3 text-sm">
      {page > 1 ? <Link href={href(page - 1)} className="rounded border border-slate-300 px-3 py-1">Anterior</Link> : null}
      <span className="text-slate-600">
        Página {page} de {pages} · {total} resultado(s)
      </span>
      {page < pages ? <Link href={href(page + 1)} className="rounded border border-slate-300 px-3 py-1">Seguinte</Link> : null}
    </nav>
  );
}
