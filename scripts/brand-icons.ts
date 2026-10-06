/**
 * Gera os ícones da aplicação a partir do wordmark oficial (src/components/brand/icon-art.ts):
 * - src/app/icon.svg        separador (Chrome, Edge, Firefox), com troca para cyan em modo escuro;
 * - src/app/favicon.ico     16/32/48 px, rasterizados do mesmo desenho em azul profundo;
 * - src/app/apple-icon.png  180 px, quadrado opaco para o ecrã principal do iOS.
 *
 * Usa o Chromium do Playwright (já devDependency) para rasterizar; sem dependências novas.
 * Uso: `pnpm brand:icons` (voltar a correr se o ficheiro vetorial oficial mudar).
 */
import { writeFileSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import {
  APPLE_ICON_SIZE,
  appleIconSvg,
  FAVICON_SIZES,
  packIco,
  tabIconSvg,
} from "../src/components/brand/icon-art";

const APP_DIR = new URL("../src/app/", import.meta.url);

async function rasterize(browser: Browser, svg: string, size: number, transparent: boolean): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="${src}"></body></html>`,
  );
  await page.locator("img").evaluate((img: HTMLImageElement) => img.decode());
  const png = await page.screenshot({ omitBackground: transparent });
  await page.close();
  return png;
}

async function main() {
  writeFileSync(new URL("icon.svg", APP_DIR), tabIconSvg({ adaptive: true }));

  const browser = await chromium.launch();
  try {
    const fixed = tabIconSvg({ adaptive: false });
    const frames = [];
    for (const size of FAVICON_SIZES) frames.push({ size, png: await rasterize(browser, fixed, size, true) });
    writeFileSync(new URL("favicon.ico", APP_DIR), packIco(frames));
    writeFileSync(new URL("apple-icon.png", APP_DIR), await rasterize(browser, appleIconSvg(), APPLE_ICON_SIZE, false));
  } finally {
    await browser.close();
  }
  console.log("Ícones gerados em src/app: icon.svg, favicon.ico, apple-icon.png");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
