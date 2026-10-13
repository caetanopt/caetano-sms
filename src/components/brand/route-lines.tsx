/**
 * Motivo decorativo: trajetos que se ligam ("a Caetano liga trajetos", §02.1). Linhas finas que se
 * desenham ao carregar; puramente decorativo (aria-hidden) e sem movimento com reduced-motion.
 */
export function RouteLines({ className = "" }: { className?: string }) {
  const routes = [
    "M-40 520 C 160 470, 220 300, 420 300 S 700 420, 860 260 S 1080 120, 1260 160",
    "M-40 600 C 200 560, 320 420, 520 430 S 820 560, 980 400 S 1160 260, 1260 290",
    "M-40 420 C 120 380, 260 160, 460 180 S 760 300, 900 140 S 1100 20, 1260 40",
  ];
  return (
    <svg aria-hidden="true" viewBox="0 0 1200 640" preserveAspectRatio="xMidYMid slice" className={className} fill="none">
      <defs>
        <linearGradient id="route-glow" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#00aeef" stopOpacity="0" />
          <stop offset="0.35" stopColor="#00aeef" stopOpacity="0.9" />
          <stop offset="1" stopColor="#66cef5" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      {routes.map((d, i) => (
        <path
          key={d}
          d={d}
          pathLength={1}
          stroke="url(#route-glow)"
          strokeWidth={i === 0 ? 2.5 : 1.25}
          strokeLinecap="round"
          strokeDasharray="1"
          className="animate-draw"
          style={{ animationDelay: `${i * 220}ms`, opacity: i === 0 ? 1 : 0.55 }}
        />
      ))}
      {[
        [420, 300],
        [860, 260],
        [520, 430],
      ].map(([cx, cy], i) => (
        <g key={`${cx}-${cy}`} className="animate-fade" style={{ animationDelay: `${1400 + i * 200}ms` }}>
          <circle cx={cx} cy={cy} r={10} fill="#00aeef" opacity={0.18} />
          <circle cx={cx} cy={cy} r={3.5} fill="#fff" />
        </g>
      ))}
    </svg>
  );
}
