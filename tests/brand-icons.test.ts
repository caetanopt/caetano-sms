import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPLE_ICON_SIZE,
  APPLE_WORDMARK_WIDTH,
  appleIconSvg,
  BRAND_CYAN,
  BRAND_DEEP,
  FAVICON_SIZES,
  ICON_CANVAS,
  packIco,
  TAB_WORDMARK_WIDTH,
  tabIconSvg,
  wordmarkBox,
} from "@/components/brand/icon-art";
import { WORDMARK_PATHS } from "@/components/brand/wordmark-paths";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const appFile = (name: string) => readFileSync(new URL(`../src/app/${name}`, import.meta.url));

function pngHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    signature: [...bytes.subarray(0, 8)],
    width: view.getUint32(16),
    height: view.getUint32(20),
    colorType: bytes[25],
  };
}

function readIco(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  return {
    reserved: view.getUint16(0, true),
    type: view.getUint16(2, true),
    entries: Array.from({ length: count }, (_, index) => {
      const entry = 6 + 16 * index;
      const size = view.getUint32(entry + 8, true);
      const offset = view.getUint32(entry + 12, true);
      return {
        width: view.getUint8(entry) || 256,
        height: view.getUint8(entry + 1) || 256,
        bitCount: view.getUint16(entry + 6, true),
        data: bytes.subarray(offset, offset + size),
      };
    }),
  };
}

describe("arte dos ícones (wordmark oficial)", () => {
  const box = wordmarkBox();

  it("usa todos os paths oficiais do wordmark, sem alterações, a branco", () => {
    for (const svg of [tabIconSvg({ adaptive: true }), tabIconSvg({ adaptive: false }), appleIconSvg()]) {
      for (const d of WORDMARK_PATHS) expect(svg).toContain(`<path d="${d}"/>`);
      expect(svg).toContain('fill="#ffffff"');
      expect(svg).not.toMatch(/<text|font-family/);
    }
  });

  it("separador: wordmark a 84 % do disco, dentro da área de segurança (§02.2)", () => {
    const scale = (ICON_CANVAS * TAB_WORDMARK_WIDTH) / box.width;
    expect(tabIconSvg({ adaptive: false })).toContain(`scale(${scale.toFixed(6)})`);
    // Área de segurança medida no manual: ~0,30 × altura nas laterais e ~0,25 × altura em cima/baixo.
    const halfWidth = (box.width / 2 + 0.3 * box.height) * scale;
    const halfHeight = (box.height / 2 + 0.25 * box.height) * scale;
    expect(Math.hypot(halfWidth, halfHeight)).toBeLessThanOrEqual(ICON_CANVAS / 2);
  });

  it("separador: azul profundo, com troca para cyan só em modo escuro no SVG adaptativo", () => {
    const adaptive = tabIconSvg({ adaptive: true });
    expect(adaptive).toContain(`circle{fill:${BRAND_DEEP}}`);
    expect(adaptive).toContain(`@media (prefers-color-scheme:dark){circle{fill:${BRAND_CYAN}}}`);
    const fixed = tabIconSvg({ adaptive: false });
    expect(fixed).not.toContain("<style>");
    expect(fixed).toContain(`fill="${BRAND_DEEP}"`);
  });

  it("iOS: quadrado opaco e wordmark com pelo menos 14 px de altura (mínimo digital)", () => {
    const svg = appleIconSvg();
    expect(svg).toContain(`<rect width="${ICON_CANVAS}" height="${ICON_CANVAS}" fill="${BRAND_DEEP}"/>`);
    expect(svg).not.toMatch(/rx=|<circle/);
    const wordmarkHeightPx = (APPLE_ICON_SIZE * APPLE_WORDMARK_WIDTH * box.height) / box.width;
    expect(wordmarkHeightPx).toBeGreaterThanOrEqual(14);
  });
});

describe("packIco", () => {
  const fakePng = (n: number) => Uint8Array.from([...PNG_SIGNATURE, n]);

  it("escreve ICONDIR, entradas e imagens PNG nos offsets indicados", () => {
    const ico = readIco(packIco([{ size: 16, png: fakePng(1) }, { size: 256, png: fakePng(2) }]));
    expect(ico.reserved).toBe(0);
    expect(ico.type).toBe(1);
    expect(ico.entries.map((e) => [e.width, e.height, e.bitCount])).toEqual([[16, 16, 32], [256, 256, 32]]);
    expect([...ico.entries[0].data]).toEqual([...fakePng(1)]);
    expect([...ico.entries[1].data]).toEqual([...fakePng(2)]);
  });

  it("rejeita tamanhos fora de 1–256", () => {
    expect(() => packIco([{ size: 512, png: fakePng(1) }])).toThrow(/inválido/);
  });
});

// Os ficheiros em src/app são gerados por `pnpm brand:icons`; estes testes falham se ficarem
// desatualizados em relação ao gerador ou ao wordmark oficial.
describe("ícones versionados em src/app", () => {
  it("icon.svg corresponde ao gerador", () => {
    expect(appFile("icon.svg").toString("utf8")).toBe(tabIconSvg({ adaptive: true }));
  });

  it("favicon.ico tem frames PNG de 16, 32 e 48 px", () => {
    const ico = readIco(appFile("favicon.ico"));
    expect(ico.type).toBe(1);
    expect(ico.entries.map((e) => e.width)).toEqual([...FAVICON_SIZES]);
    for (const entry of ico.entries) {
      const header = pngHeader(entry.data);
      expect(header.signature).toEqual(PNG_SIGNATURE);
      expect([header.width, header.height]).toEqual([entry.width, entry.height]);
    }
  });

  it("apple-icon.png tem 180 × 180 px e não tem canal alfa (o iOS pintaria a transparência de preto)", () => {
    const header = pngHeader(appFile("apple-icon.png"));
    expect(header.signature).toEqual(PNG_SIGNATURE);
    expect([header.width, header.height]).toEqual([APPLE_ICON_SIZE, APPLE_ICON_SIZE]);
    expect(header.colorType).toBe(2); // RGB
  });
});
