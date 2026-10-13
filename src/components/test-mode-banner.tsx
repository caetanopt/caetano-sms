/** Texto exigido pelo CLAUDE.md §30. */
export function TestModeBanner() {
  return (
    <div className="mt-5 flex items-center gap-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
      <span aria-hidden="true" className="relative flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-orange opacity-60" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-orange" />
      </span>
      MODO DE TESTE — nenhum SMS real será enviado
    </div>
  );
}
