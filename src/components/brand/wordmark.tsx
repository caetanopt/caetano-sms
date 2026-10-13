import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from "./wordmark-paths";

const COLORS = {
  /** Sobre fundos claros (versão principal do manual, §02.1). */
  cyan: "#1fabe3",
  /** Sobre fundos claros, versão institucional (site, §09.3). */
  deep: "#002e5d",
  /** Sobre azul profundo, cyan, antracite, verde eco ou amarelo (§04.3). */
  white: "#ffffff",
} as const;

/**
 * Wordmark oficial. `height` em px (mínimo 14 px no digital, §02.2); a largura segue a proporção
 * do desenho. A área de segurança é garantida pelo espaço à volta no layout.
 */
export function Wordmark({
  color = "cyan",
  height = 28,
  className,
  title = "Caetano",
}: {
  color?: keyof typeof COLORS;
  height?: number;
  className?: string;
  title?: string;
}) {
  const [, , w, h] = WORDMARK_VIEWBOX.split(" ").map(Number);
  const size = Math.max(14, height);
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={WORDMARK_VIEWBOX}
      height={size}
      width={Math.round((size * w) / h)}
      fill={COLORS[color]}
      className={className}
    >
      {WORDMARK_PATHS.map((d) => (
        <path key={d.slice(0, 24)} d={d} />
      ))}
    </svg>
  );
}

/** Claim oficial (§07.1): Montserrat Medium, #2aa8e0 (positivo) ou branco (negativo). */
export function Claim({ negative = false, className = "" }: { negative?: boolean; className?: string }) {
  return (
    <p lang="en" className={`font-medium tracking-wide ${negative ? "text-white/85" : "text-brand-claim"} ${className}`}>
      Your favourite way to move
    </p>
  );
}
