import { WORDMARK_PATHS, WORDMARK_VIEWBOX } from "./wordmark-paths";

/**
 * Ícones da aplicação (favicon, icon.svg, apple-icon), gerados por `pnpm brand:icons` a partir do
 * wordmark oficial — nunca redesenhados nem com texto.
 *
 * - Separador do browser: tratamento do avatar oficial das redes sociais (Brand Book §09.1/§09.2):
 *   disco azul profundo com o wordmark branco, aqui a 84 % do diâmetro (o máximo que respeita a
 *   área de segurança de §02.2 é ~88 %). Em modo escuro o disco passa a azul cyan (branco sobre
 *   cyan é um comportamento aprovado, §04.3), porque o azul profundo desaparece em separadores
 *   escuros. Abaixo de ~92 px o wordmark fica aquém do mínimo de 14 px: o tamanho é imposto pelo
 *   browser, como nos avatares reduzidos pelas redes sociais.
 * - iOS (apple-icon 180 px): quadrado opaco (o iOS aplica a máscara; transparência fica preta)
 *   com o wordmark a 76 % da largura, ~25 px de altura — cumpre o mínimo de 14 px.
 */

export const BRAND_DEEP = "#002e5d";
export const BRAND_CYAN = "#00aeef";
const WHITE = "#ffffff";

/** Lado do quadro de desenho (viewBox 0 0 512 512). */
export const ICON_CANVAS = 512;
/** Largura do wordmark no disco do separador, em fração do diâmetro. */
export const TAB_WORDMARK_WIDTH = 0.84;
/** Largura do wordmark no ícone iOS, em fração do lado. */
export const APPLE_WORDMARK_WIDTH = 0.76;
export const APPLE_ICON_SIZE = 180;
/** Tamanhos dentro do favicon.ico. */
export const FAVICON_SIZES = [16, 32, 48] as const;

export function wordmarkBox() {
  const [x, y, width, height] = WORDMARK_VIEWBOX.split(" ").map(Number);
  return { x, y, width, height };
}

/** Wordmark branco, escala uniforme, centrado no quadro com a largura pedida. */
export function wordmarkGroup(widthFraction: number): string {
  const box = wordmarkBox();
  const scale = (ICON_CANVAS * widthFraction) / box.width;
  const tx = ICON_CANVAS / 2 - (box.x + box.width / 2) * scale;
  const ty = ICON_CANVAS / 2 - (box.y + box.height / 2) * scale;
  const paths = WORDMARK_PATHS.map((d) => `<path d="${d}"/>`).join("");
  return `<g fill="${WHITE}" transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(6)})">${paths}</g>`;
}

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_CANVAS} ${ICON_CANVAS}">${body}</svg>\n`;

/**
 * Ícone do separador. `adaptive` acrescenta a troca para cyan em `prefers-color-scheme: dark`
 * (icon.svg); sem ela, é a versão fixa em azul profundo usada para rasterizar o favicon.ico.
 */
export function tabIconSvg({ adaptive }: { adaptive: boolean }): string {
  const half = ICON_CANVAS / 2;
  const disc = adaptive
    ? `<style>circle{fill:${BRAND_DEEP}}@media (prefers-color-scheme:dark){circle{fill:${BRAND_CYAN}}}</style><circle cx="${half}" cy="${half}" r="${half}"/>`
    : `<circle cx="${half}" cy="${half}" r="${half}" fill="${BRAND_DEEP}"/>`;
  return svg(disc + wordmarkGroup(TAB_WORDMARK_WIDTH));
}

/** Ícone iOS: quadrado opaco em azul profundo, sem cantos arredondados nem transparência. */
export function appleIconSvg(): string {
  return svg(`<rect width="${ICON_CANVAS}" height="${ICON_CANVAS}" fill="${BRAND_DEEP}"/>` + wordmarkGroup(APPLE_WORDMARK_WIDTH));
}

/** Empacota PNGs num .ico (cabeçalho ICONDIR + entradas de 16 bytes + imagens PNG). */
export function packIco(images: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const headerSize = 6 + 16 * images.length;
  const total = headerSize + images.reduce((sum, image) => sum + image.png.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reservado
  view.setUint16(2, 1, true); // tipo 1 = ícone
  view.setUint16(4, images.length, true);
  let offset = headerSize;
  images.forEach((image, index) => {
    if (image.size < 1 || image.size > 256) throw new Error(`Tamanho de ícone inválido: ${image.size}`);
    const entry = 6 + 16 * index;
    view.setUint8(entry, image.size === 256 ? 0 : image.size); // largura (0 = 256)
    view.setUint8(entry + 1, image.size === 256 ? 0 : image.size); // altura
    view.setUint8(entry + 2, 0); // paleta
    view.setUint8(entry + 3, 0); // reservado
    view.setUint16(entry + 4, 1, true); // planos
    view.setUint16(entry + 6, 32, true); // bits por pixel
    view.setUint32(entry + 8, image.png.length, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.length;
  });
  return out;
}
