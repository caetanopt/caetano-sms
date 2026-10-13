import jsQR from "jsqr";

/**
 * Descodifica o QR a partir do atributo `d` do SVG gerado (segmentos "Mx yhWv1h-Wz"),
 * rasterizando-o: prova que o que é desenhado — e não só a matriz — é legível.
 */
export function decodeQrPath(d: string, totalModules: number, scale = 6): string | null {
  const width = totalModules * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const match of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(match[1]), Number(match[2]), Number(match[3])];
    for (let py = y * scale; py < (y + 1) * scale; py += 1) {
      for (let px = x * scale; px < (x + w) * scale; px += 1) {
        const i = (py * width + px) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      }
    }
  }
  return jsQR(pixels, width, width)?.data ?? null;
}
