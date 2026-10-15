#!/usr/bin/env node
// Sets the raw app captures from tests/e2e/store-shots.spec.ts into
// monochrome Mac App Store frames at Apple's 2880x1800 size, plus a contact
// sheet. Renders HTML with Playwright's bundled Chromium at 2x, so the type is
// real text and the capture is placed at exact pixel scale.
//
//   node scripts/compose-store-shots.mjs [rawDir] [outDir]
//
// Defaults: store-shots/raw -> ~/Downloads/mac-app-store-screenshots
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const RAW = resolve(process.argv[2] ?? join(here, "..", "store-shots", "raw"));
const OUT = resolve(process.argv[3] ?? join(homedir(), "Downloads", "mac-app-store-screenshots"));

const FONT_DIR = join(repo, "public", "fonts");
const LOGO = readFileSync(join(repo, "public", "brand", "logo-mono.svg"), "utf8")
  .replace(/width="\d+" height="\d+"/, "")
  .replace(/#18181b/g, "currentColor");

/** Order on the store page, one caption each. Captions are short on purpose: Apple shows them small. */
const SHOTS = [
  { view: "files", title: "Your files, native on the Mac", sub: "Every workspace, every file, in a window that feels like it belongs here." },
  { view: "sync", title: "Sync any folder, both ways", sub: "Pick a folder. Changes flow up and down, conflicts kept, nothing lost." },
  { view: "lan", title: "Send files across the room", sub: "A room code moves files between devices on the same network. No cloud hop." },
  { view: "dashboard", title: "Everything at a glance", sub: "Storage, activity and recent files for the workspace you are in." },
  { view: "add-folder", title: "Pick a folder, start syncing", sub: "Browse anywhere, or one click for Desktop, Documents, Pictures and Downloads." },
  { view: "sync-modes", title: "Five ways to sync", sub: "Full sync, push, protect and upload, pull, or save to device. Chosen per folder." },
  { view: "appearance", title: "Eight themes, one green", sub: "Light, dark and six more. The same look on the web, Windows and your phone." },
];

// A page set from a string has an opaque origin and cannot fetch file:// URLs,
// so fonts and captures are inlined as data: URIs.
const dataUri = (path, mime) => `data:${mime};base64,${readFileSync(path).toString("base64")}`;
const fontFace = (name, file, weight) =>
  `@font-face{font-family:"${name}";src:url("${dataUri(join(FONT_DIR, file), "font/woff2")}") format("woff2");font-weight:${weight};font-display:block}`;

function frameHtml({ title, sub, mode, imageUrl, index, total }) {
  const dark = mode === "dark";
  const bg = dark ? "#0a0a0a" : "#f4f4f4";
  const ink = dark ? "#f4f4f4" : "#111111";
  const muted = dark ? "#8a8a8a" : "#6b6b6b";
  const hair = dark ? "#2a2a2a" : "#d9d9d9";
  const chrome = dark ? "#161616" : "#ececec";
  const lights = dark ? "#3a3a3a" : "#c9c9c9";
  const shadow = dark ? "0 40px 90px rgba(0,0,0,0.6)" : "0 40px 90px rgba(0,0,0,0.14)";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace("Space Grotesk", "space-grotesk-latin.woff2", "400 700")}
${fontFace("Space Mono", "space-mono-latin.woff2", "400")}
html,body{margin:0;width:1440px;height:900px;background:${bg};color:${ink};overflow:hidden}
body{font-family:"Space Grotesk",system-ui,sans-serif;-webkit-font-smoothing:antialiased;position:relative}
.head{position:absolute;left:84px;top:64px;right:84px;display:flex;align-items:flex-start;justify-content:space-between}
.title{font-size:46px;font-weight:700;letter-spacing:-0.035em;line-height:1.05;margin:0}
.sub{font-size:19px;font-weight:400;color:${muted};margin:14px 0 0;max-width:760px;line-height:1.4}
.brand{display:flex;align-items:center;gap:12px;color:${ink};font-family:"Space Mono",ui-monospace,monospace;font-size:15px;letter-spacing:0.04em;margin-top:10px}
.brand svg{width:28px;height:28px}
.count{color:${muted}}
.win{position:absolute;left:144px;right:144px;top:244px;height:720px;border-radius:14px;border:1px solid ${hair};box-shadow:${shadow};overflow:hidden;background:${chrome}}
.lights{position:absolute;left:16px;top:10px;display:flex;gap:8px;z-index:2}
.dot{width:11px;height:11px;border-radius:50%;background:${lights}}
.shot{position:absolute;left:0;right:0;top:0;bottom:0;background:${bg}}
.shot img{width:1152px;height:720px;display:block;object-fit:cover;object-position:top left}
</style></head><body>
<div class="head">
  <div><h1 class="title">${title}</h1><p class="sub">${sub}</p></div>
  <div class="brand">${LOGO}<span>dosya</span><span class="count">${String(index).padStart(2, "0")}/${String(total).padStart(2, "0")}</span></div>
</div>
<div class="win">
  <div class="lights"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <div class="shot"><img src="${imageUrl}"></div>
</div>
</body></html>`;
}

function sheetHtml(files) {
  const cells = files.map((f) => `<figure><img src="${dataUri(f, "image/png")}"><figcaption>${f.split("/").pop()}</figcaption></figure>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace("Space Mono", "space-mono-latin.woff2", "400")}
html,body{margin:0;background:#1a1a1a;color:#ddd;font-family:"Space Mono",monospace;font-size:11px}
body{width:1440px;padding:24px;box-sizing:border-box;display:grid;grid-template-columns:repeat(2,1fr);gap:24px}
figure{margin:0}img{width:100%;display:block;border:1px solid #333}figcaption{margin-top:6px}
</style></head><body>${cells}</body></html>`;
}

async function main() {
  if (!existsSync(RAW)) throw new Error(`no raw captures at ${RAW}; run STORE_SHOTS=1 npx playwright test tests/e2e/store-shots.spec.ts first`);
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const written = [];
  try {
    for (const mode of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const page = await context.newPage();
      let index = 0;
      for (const shot of SHOTS) {
        const raw = join(RAW, `${shot.view}-${mode}.png`);
        if (!existsSync(raw)) { console.warn(`[compose] missing ${raw}, skipped`); continue; }
        index += 1;
        await page.setContent(frameHtml({ ...shot, mode, imageUrl: dataUri(raw, "image/png"), index, total: SHOTS.length }), { waitUntil: "load" });
        await page.evaluate(() => document.fonts.ready);
        const out = join(OUT, `${String(index).padStart(2, "0")}-${shot.view}-${mode}.png`);
        await page.screenshot({ path: out, type: "png", omitBackground: false });
        written.push(out);
        console.log(`[compose] ${out}`);
      }
      await context.close();
    }
    const sheet = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await sheet.setContent(sheetHtml(written), { waitUntil: "load" });
    await sheet.evaluate(() => document.fonts.ready);
    await sheet.screenshot({ path: join(OUT, "contact-sheet.png"), fullPage: true });
    console.log(`[compose] ${join(OUT, "contact-sheet.png")}`);
  } finally {
    await browser.close();
  }
  console.log(`[compose] ${written.length} screenshots at 2880x1800 in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
