import { Claim, Wordmark } from "./brand/wordmark";
import { RouteLines } from "./brand/route-lines";

/** Ecrã de estado em página inteira (404, erro inesperado), com a identidade da marca. */
export function StatusScreen({
  code,
  title,
  children,
  actions,
}: {
  code: string;
  title: string;
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <main className="relative isolate flex min-h-screen flex-col overflow-hidden bg-brand-deep px-6 py-8 text-white sm:px-12 sm:py-12">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(900px_500px_at_85%_10%,rgb(0_174_239/0.35),transparent_60%),radial-gradient(700px_500px_at_0%_100%,rgb(102_206_245/0.18),transparent_60%)]" />
      <RouteLines className="absolute inset-0 -z-10 h-full w-full opacity-60" />
      <div className="animate-fade">
        <Wordmark color="white" height={30} />
      </div>
      <div className="my-auto max-w-xl animate-enter py-16">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-brand-cyan-60">{code}</p>
        <h1 className="mt-3 text-4xl font-bold text-white sm:text-5xl">{title}</h1>
        <div className="mt-4 text-white/75">{children}</div>
        <div className="mt-8 flex flex-wrap gap-3">{actions}</div>
      </div>
      <Claim negative className="text-sm" />
    </main>
  );
}

export const primaryAction =
  "rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-brand-deep shadow-sm hover:bg-brand-sky";
export const secondaryAction =
  "rounded-lg px-5 py-2.5 text-sm font-semibold text-white ring-1 ring-white/30 hover:bg-white/10";
