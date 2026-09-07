/**
 * Render the mark as a 480x480 PNG, which is what a BUIDL listing asks for.
 *
 * The site has the mark as SVG and a 1200x630 OG card, and neither is a square tile. DoraHacks
 * wants JPEG or PNG at 480x480, so this draws the same geometry the favicon and the masthead
 * use — channel one solid ink, channel two the second pen, the price a gap the paper shows
 * through — on the paper the whole site is printed on.
 *
 *   node scripts/logo-tile.mjs        # writes public/logo-480.png
 *
 * Playwright rather than an image library because it is already here for the browser suite,
 * and because rendering the real SVG is the only way to be sure the tile and the site show the
 * same mark.
 */
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";

const SIZE = 480;

/* The mark is 20 wide by 38 tall. Centred with generous margin, because a listing shows it
 * small and next to other people's logos, where a crowded tile reads as noise. */
const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; }
  body { width: ${SIZE}px; height: ${SIZE}px; background: #F5F1E6;
         display: flex; align-items: center; justify-content: center; }
  svg { width: ${Math.round(SIZE * 0.34)}px; height: ${Math.round(SIZE * 0.646)}px; display: block; }
</style>
<svg viewBox="0 0 20 38" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="4" width="11.7" height="30" fill="#16262B"/>
  <rect x="13.1" y="4" width="6.9" height="30" fill="#2A3A6B"/>
  <path d="M12.4 0V38" stroke="#B4331C" stroke-width="1.4"/>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
await page.setContent(html);
const png = await page.screenshot({ type: "png" });
await browser.close();

writeFileSync("public/logo-480.png", png);
console.log(`wrote public/logo-480.png  (${SIZE}x${SIZE}, ${png.length} bytes)`);
