// Renders the banner SVGs to PNG at their exact pixel size: node assets/src/render-png.mjs
// Build-time only. Needs Playwright with its bundled Chromium (headless; never an installed browser).
import { createRequire } from 'node:module';
import { delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..');
const jobs = [['banner-1280x640.svg', 'banner-1280x640.png', 1280, 640], ['banner-linkedin-1200x627.svg', 'banner-linkedin-1200x627.png', 1200, 627]];
// Playwright is not a dependency of this repo: found next to the script, or on NODE_PATH (e.g. a global install).
const req = createRequire(import.meta.url);
const { chromium } = req(req.resolve('playwright', { paths: [process.cwd(), ...(process.env.NODE_PATH || '').split(delimiter).filter(Boolean)] }));
const browser = await chromium.launch();
for (const [svg, png, w, h] of jobs) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(join(assets, svg)).href);
  await page.screenshot({ path: join(assets, png), clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  process.stderr.write(`${png} ${w}x${h}\n`);
}
await browser.close();
process.stdout.write(JSON.stringify({ ok: true, rendered: jobs.map((j) => j[1]) }) + '\n');
