// usage: node compose.mjs <locale> <outdir>
// The README hero: the desktop session behind, the phone signing with a Passkey in front.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const [locale, out] = process.argv.slice(2);
const require = createRequire(new URL("../../web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const data = (name) => `data:image/png;base64,${readFileSync(`${out}/${name}.${locale}.png`).toString("base64")}`;

const W = 1600;
const H = 980;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; }
body { width: ${W}px; height: ${H}px; position: relative; overflow: hidden;
  background: radial-gradient(120% 90% at 20% 10%, #f4f7fb 0%, #e3e9f2 55%, #d3dce9 100%); }
.desktop { position: absolute; left: 64px; top: 60px; width: 1240px; border-radius: 14px; overflow: hidden;
  background: #fff; border: 1px solid rgba(15, 23, 42, .12);
  box-shadow: 0 30px 80px -20px rgba(15, 23, 42, .35), 0 8px 24px -8px rgba(15, 23, 42, .18); }
.bar { height: 30px; background: #f1f4f8; border-bottom: 1px solid rgba(15, 23, 42, .08); display: flex; align-items: center; gap: 8px; padding: 0 14px; }
.bar i { width: 11px; height: 11px; border-radius: 50%; background: #d4dae3; display: block; }
.desktop img { display: block; width: 100%; }
.phone { position: absolute; right: 72px; bottom: 40px; width: 322px; padding: 11px; border-radius: 52px; background: #111418;
  box-shadow: 0 40px 90px -20px rgba(15, 23, 42, .55), 0 10px 30px -10px rgba(15, 23, 42, .35), inset 0 0 0 2px #2a2f36; }
.phone .screen { border-radius: 42px; overflow: hidden; position: relative; background: #fff; }
.phone .screen img { display: block; width: 100%; padding-top: 30px; }
.phone .screen::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 30px; background: #fff; }
.phone .screen::after { content: ""; position: absolute; top: 9px; left: 50%; width: 92px; height: 24px; margin-left: -46px; border-radius: 12px; background: #111418; }
</style></head><body>
<div class="desktop"><div class="bar"><i></i><i></i><i></i></div><img src="${data("session")}"></div>
<div class="phone"><div class="screen"><img src="${data("phone-signature")}"></div></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1.5 });
await page.setContent(html, { waitUntil: "load" });
writeFileSync(`${out}/hero.${locale}.png`, await page.screenshot({ type: "png" }));
await browser.close();
console.log(`hero.${locale}.png`);
