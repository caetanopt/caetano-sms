import { create } from "qrcode";

/**
 * QR code do URI `otpauth://` para configurar o 2FA. Gerado no servidor e desenhado como SVG
 * pelo React a partir da matriz (sem innerHTML, sem data: URLs, sem pedidos externos).
 */
export type QrMatrix = { size: number; dark: (x: number, y: number) => boolean };

export function qrMatrix(text: string): QrMatrix {
  // Nível M: bom compromisso entre densidade e tolerância a erros para ecrãs.
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  return { size: modules.size, dark: (x, y) => modules.data[y * modules.size + x] === 1 };
}

/** Margem recomendada pela norma (quiet zone). */
export const QR_QUIET_ZONE = 4;

/**
 * Caminho SVG com um retângulo por sequência horizontal de módulos escuros (menos nós que um
 * retângulo por módulo). Coordenadas em módulos, já com a margem.
 */
export function qrSvgPath(matrix: QrMatrix, quiet = QR_QUIET_ZONE): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    let x = 0;
    while (x < matrix.size) {
      if (!matrix.dark(x, y)) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < matrix.size && matrix.dark(x, y)) x += 1;
      parts.push(`M${start + quiet} ${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  }
  return parts.join("");
}
