const STYLES = {
  OPTED_IN: "bg-emerald-100 text-emerald-900",
  OPTED_OUT: "bg-red-100 text-red-900",
  UNKNOWN: "bg-slate-100 text-slate-700",
} as const;

const LABELS = { OPTED_IN: "Opt-in", OPTED_OUT: "Opt-out", UNKNOWN: "Desconhecido" } as const;

export function ConsentBadge({ status, optedOut }: { status: keyof typeof STYLES; optedOut?: boolean }) {
  const effective = optedOut ? "OPTED_OUT" : status;
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STYLES[effective]}`}>{LABELS[effective]}</span>
  );
}
