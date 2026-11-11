// Offline stand-in for yt-dlp, gallery-dl, instaloader and ffmpeg in the tests and the demo. No network.
//   node fake-tool.mjs --as <yt-dlp|gallery-dl|instaloader|ffmpeg> <the real tool's arguments...>
// FAKE_MODE=ok|login|429 picks the outcome; FAKE_YTDLP=carousel swaps the yt-dlp fixture;
// FAKE_LOG=<file> appends each call's arguments as one JSON line, so tests can check the flags that were passed.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const as = argv[0] === '--as' ? argv[1] : 'yt-dlp';
const a = argv[0] === '--as' ? argv.slice(2) : argv;
const fx = (n) => readFileSync(new URL('./' + n, import.meta.url), 'utf8');
const mode = process.env.FAKE_MODE || 'ok';
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify({ as, args: a }) + '\n');

if (a.includes('--version') || a.includes('-version')) { console.log(`${as} 0.0-fake`); process.exit(0); }

if (as === 'ffmpeg') { writeFileSync(a[a.length - 1], 'fake-jpeg'); process.exit(0); }

if (mode === 'login') { console.error('ERROR: [Instagram] DAbCdEf: Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in'); process.exit(1); }
if (mode === '429') { console.error('ERROR: HTTP Error 429: Too Many Requests'); process.exit(1); }

if (as === 'yt-dlp') {
  if (!a.includes('--ignore-config') || !a.includes('--no-cookies')) { console.error('fake: missing --ignore-config / --no-cookies'); process.exit(9); }
  if (a.includes('--dump-single-json')) { console.log(fx(process.env.FAKE_YTDLP === 'carousel' ? 'ytdlp-carousel.json' : 'ytdlp-reel.json')); process.exit(0); }
  const o = a.indexOf('-o');
  if (o >= 0) { writeFileSync(a[o + 1].replace('%(autonumber)s', '00001').replace('%(ext)s', 'mp4'), 'fake-video'); process.exit(0); }
}
if (as === 'gallery-dl') {
  if (!a.includes('--ignore-config')) { console.error('fake: missing --ignore-config'); process.exit(9); }
  if (a.includes('-j')) { console.log(fx('gallerydl.json')); process.exit(0); }
  const d = a.indexOf('-D');
  if (d >= 0) { mkdirSync(a[d + 1], { recursive: true }); writeFileSync(join(a[d + 1], 'photo-1.jpg'), 'fake-image'); process.exit(0); }
}
if (as === 'instaloader') {
  if (a.includes('--login') || a.includes('--load-cookies')) { console.error('fake: a login flag was passed'); process.exit(9); }
  const d = a.indexOf('--dirname-pattern');
  if (d >= 0) { writeFileSync(join(a[d + 1], '2024-11-10_00-53-20_UTC.json'), fx('instaloader.json')); process.exit(0); }
}
process.exit(0);
