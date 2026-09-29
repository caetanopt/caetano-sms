import { QR_QUIET_ZONE, qrMatrix, qrSvgPath } from "@/features/auth/qr";

/** Componente de servidor: o conteúdo do QR nunca é processado no browser. */
export function QrCode({ text, label, size = 224 }: { text: string; label: string; size?: number }) {
  const matrix = qrMatrix(text);
  const total = matrix.size + QR_QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="totp-qr"
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      shapeRendering="crispEdges"
      className="rounded border border-slate-200"
    >
      {/* Cores fixas: o contraste escuro sobre claro é necessário para a leitura. */}
      <rect width={total} height={total} fill="#ffffff" />
      <path d={qrSvgPath(matrix)} fill="#000000" />
    </svg>
  );
}
