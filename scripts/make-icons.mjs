/*
 * One-off PWA icon generator. Renders the Simba Pomeranian to PNGs using the
 * pre-installed Chromium (via playwright-core). The PNGs it writes are committed
 * as static assets; this script is NOT part of the build. To regenerate:
 *   npm i -D playwright-core && node scripts/make-icons.mjs
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.CHROME_BIN || "/opt/pw-browsers/chromium/chrome-linux/chrome";

// The Pomeranian mascot (80x80 viewBox), reused from the splash.
const DOG = `
  <g fill="#dd854b">
    <circle cx="40" cy="13" r="9"/><circle cx="55" cy="16" r="9"/><circle cx="65" cy="27" r="9"/>
    <circle cx="68" cy="41" r="9"/><circle cx="64" cy="55" r="9"/><circle cx="54" cy="64" r="9"/>
    <circle cx="40" cy="68" r="9"/><circle cx="26" cy="64" r="9"/><circle cx="16" cy="55" r="9"/>
    <circle cx="12" cy="41" r="9"/><circle cx="15" cy="27" r="9"/><circle cx="25" cy="16" r="9"/>
  </g>
  <g fill="#efa863">
    <circle cx="40" cy="18" r="8"/><circle cx="52" cy="21" r="8"/><circle cx="60" cy="30" r="8"/>
    <circle cx="62" cy="42" r="8"/><circle cx="58" cy="53" r="8"/><circle cx="49" cy="60" r="8"/>
    <circle cx="40" cy="62" r="8"/><circle cx="31" cy="60" r="8"/><circle cx="22" cy="53" r="8"/>
    <circle cx="18" cy="42" r="8"/><circle cx="20" cy="30" r="8"/><circle cx="28" cy="21" r="8"/>
  </g>
  <path d="M18 22 L24 6 L34 18 Z" fill="#cf7a42"/>
  <path d="M62 22 L56 6 L46 18 Z" fill="#cf7a42"/>
  <path d="M21 20 L24 10 L31 18 Z" fill="#f1bd8b"/>
  <path d="M59 20 L56 10 L49 18 Z" fill="#f1bd8b"/>
  <circle cx="40" cy="40" r="22" fill="#f6c891"/>
  <ellipse cx="40" cy="44" rx="17" ry="16" fill="#fdf4e7"/>
  <ellipse cx="25" cy="44" rx="4" ry="2.6" fill="#f3a39c" opacity=".55"/>
  <ellipse cx="55" cy="44" rx="4" ry="2.6" fill="#f3a39c" opacity=".55"/>
  <ellipse cx="31" cy="38" rx="4.2" ry="4.8" fill="#3a2a1e"/>
  <ellipse cx="49" cy="38" rx="4.2" ry="4.8" fill="#3a2a1e"/>
  <circle cx="32.6" cy="36.2" r="1.5" fill="#fff"/>
  <circle cx="50.6" cy="36.2" r="1.5" fill="#fff"/>
  <path d="M36.5 46 q3.5 3 7 0 q-1 3.1 -3.5 3.1 q-2.5 0 -3.5 -3.1 Z" fill="#41312a"/>
  <path d="M40 49 v2.2" stroke="#7a5a3a" stroke-width="1" stroke-linecap="round"/>
  <path d="M40 51.2 q-3 3 -6 1.2 M40 51.2 q3 3 6 1.2" stroke="#7a5a3a" stroke-width="1.1" fill="none" stroke-linecap="round"/>`;

// rounded = app-icon look (rounded square, padded). maskable = full-bleed bg
// (Android masks it), dog kept inside the safe center zone.
function svg({ size, maskable }) {
  const pad = maskable ? size * 0.22 : size * 0.16;
  const inner = size - pad * 2;
  const scale = inner / 80;
  const bg = maskable
    ? `<rect width="${size}" height="${size}" fill="#d97757"/>`
    : `<rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#d97757"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${bg}
    <g transform="translate(${pad} ${pad}) scale(${scale})">${DOG}</g>
  </svg>`;
}

const targets = [
  { file: "assets/icon-192.png", size: 192, maskable: false },
  { file: "assets/icon-512.png", size: 512, maskable: false },
  { file: "assets/icon-maskable-512.png", size: 512, maskable: true },
  { file: "assets/apple-touch-icon.png", size: 180, maskable: true },
];

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
for (const t of targets) {
  const markup = svg(t);
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<!doctype html><html><body style="margin:0">${markup}</body></html>`);
  const el = await page.$("svg");
  const buf = await el.screenshot({ omitBackground: true });
  writeFileSync(resolve(root, t.file), buf);
  console.log("wrote", t.file, `(${buf.length} bytes)`);
}
// Also drop the source SVG for the manifest's vector entry + favicon.
writeFileSync(resolve(root, "assets/icon.svg"), svg({ size: 512, maskable: false }));
console.log("wrote assets/icon.svg");
await browser.close();
