import { Claim, Wordmark } from "./brand/wordmark";
import { RouteLines } from "./brand/route-lines";
import { ConsumeFlashParams } from "./consume-flash-params";

/**
 * Layout das páginas de autenticação e conta: painel de marca (azul profundo, wordmark branco,
 * claim) e o formulário num cartão. Em ecrãs pequenos o painel reduz-se a um cabeçalho.
 */
export function AuthLayout({
  title,
  subtitle,
  children,
  wide = false,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section aria-label="Caetano" className="relative isolate overflow-hidden bg-brand-deep px-8 py-8 text-white lg:flex lg:flex-col lg:justify-between lg:px-14 lg:py-12">
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(900px_500px_at_85%_10%,rgb(0_174_239/0.35),transparent_60%),radial-gradient(700px_500px_at_0%_100%,rgb(102_206_245/0.18),transparent_60%)]" />
        <RouteLines className="absolute inset-0 -z-10 hidden h-full w-full opacity-80 lg:block" />
        <div className="animate-fade">
          <Wordmark color="white" height={34} />
          <p className="mt-3 text-[0.7rem] font-semibold uppercase tracking-[0.3em] text-brand-cyan-60">Plataforma SMS</p>
        </div>
        <div className="mt-10 hidden max-w-md animate-enter lg:block" style={{ animationDelay: "250ms" }}>
          <h2 className="text-4xl font-light leading-tight text-white">
            Comunicação ao serviço da <span className="font-bold">mobilidade</span>.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/70">
            Envio seguro de SMS com consentimento verificado, auditoria completa e controlo de cada campanha.
          </p>
          <Claim negative className="mt-10 text-base" />
        </div>
      </section>

      <section className="flex items-center justify-center px-6 py-10 sm:px-10">
        <div className={`w-full animate-enter ${wide ? "max-w-2xl" : "max-w-md"}`}>
          <div className="rounded-2xl border border-slate-200/70 bg-white/90 p-8 shadow-[0_24px_60px_-28px_rgb(0_46_93/0.35)] backdrop-blur sm:p-10">
            <h1 className="text-2xl font-bold">{title}</h1>
            {subtitle ? <div className="mt-2 text-sm text-slate-600">{subtitle}</div> : null}
            {children}
            {/* Login, palavra-passe e 2FA mostram as suas mensagens sem <Feedback> (só as com assinatura
                válida, readFlash); aqui retiram-se do URL, incluindo as forjadas ou expiradas. */}
            <ConsumeFlashParams />
          </div>
          <p className="mt-6 text-center text-xs text-slate-400">Acesso reservado a utilizadores autorizados · Grupo Salvador Caetano</p>
        </div>
      </section>
    </main>
  );
}
