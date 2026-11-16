import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(root).filter(name => statSync(join(root, name)).isFile());
const art = files.filter(name => /-v[1-4]\.png$/.test(name));
const read = name => readFileSync(join(root, name));
const hash = data => createHash('sha256').update(data).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(data) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function decodePng(data) {
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const idat = [];
  let header, ended = false;
  for (let offset = 8; offset < data.length;) {
    const size = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const payload = data.subarray(offset + 8, offset + 8 + size);
    assert.equal(crc(data.subarray(offset + 4, offset + 8 + size)), data.readUInt32BE(offset + 8 + size), type);
    if (type === 'IHDR') header = payload;
    if (type === 'IDAT') idat.push(payload);
    offset += size + 12;
    if (type === 'IEND') { assert.equal(offset, data.length); ended = true; break; }
  }
  assert.ok(header && ended);
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4);
  assert.equal(header[8], 8, '8-bit PNG');
  assert.ok([2, 6].includes(header[9]), 'RGB or RGBA PNG');
  assert.equal(header[12], 0, 'non-interlaced PNG');
  const channels = header[9] === 2 ? 3 : 4;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  assert.equal(raw.length, height * (stride + 1));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? pixels[at - channels] : 0;
      const up = y ? pixels[at - stride] : 0;
      const corner = y && x >= channels ? pixels[at - stride - channels] : 0;
      const predicted = left + up - corner;
      const a = Math.abs(predicted - left), b = Math.abs(predicted - up), c = Math.abs(predicted - corner);
      const paeth = a <= b && a <= c ? left : b <= c ? up : corner;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth][filter];
      pixels[at] = raw[y * (stride + 1) + 1 + x] + predictor;
    }
  }
  return { width, height, channels, pixels };
}

test('44 unique PNGs decode at the delivery dimensions; heroes have no white edge bands', () => {
  assert.equal(art.length, 44);
  assert.equal(new Set(art.map(name => hash(read(name)))).size, 44);
  for (const name of art) {
    const { width, height, channels, pixels } = decodePng(read(name));
    const expected = name.startsWith('profile-') ? [1600, 500]
      : name.startsWith('cover-') ? [1200, 630] : name.startsWith('social-') ? [1280, 640] : [1600, 900];
    assert.deepEqual([width, height], expected, name);
    if (name.startsWith('profile-')) for (const y of [...Array(20).keys(), ...Array.from({ length: 20 }, (_, i) => height - 1 - i)]) {
      let white = 0;
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * channels;
        if (pixels[at] > 235 && pixels[at + 1] > 235 && pixels[at + 2] > 235) white++;
      }
      assert.ok(white / width < 0.6, `${name}: white edge band at row ${y}`);
    }
  }
});

test('companions reference local assets, preserve motion controls and stay below the delivery budget', () => {
  const pages = files.filter(name => name.endsWith('.html'));
  assert.equal(pages.length, 44);
  for (const name of pages) {
    const html = read(name).toString();
    assert.ok(html.includes(`src="${name.replace(/\.html$/, '.png')}"`), name);
    assert.doesNotMatch(html, /data:|https?:|<script\b/i, name);
    assert.match(html, /@media\(prefers-reduced-motion:reduce\)/);
    assert.match(html, /animation:none!important/);
    assert.match(html, /overflow-x:hidden/);
    assert.doesNotMatch(html, /body\{[^}]*overflow:hidden/);
    for (const [, target] of html.matchAll(/(?:src|srcset|href)="([^"]+)"/g)) assert.ok(files.includes(target), `${name}: ${target}`);
    if (/agentroid|profile-hero/.test(name)) {
      assert.match(html, /media="\(prefers-reduced-motion: reduce\)" srcset="agentroid-demo-still.png"/);
      assert.match(html, /src="agentroid-demo.gif"/);
    }
    if (/headless-kit|profile-hero/.test(name)) assert.match(html, /src="reddit-pull-demo.svg"/);
  }
  assert.ok(pages.reduce((sum, name) => sum + statSync(join(root, name)).size, 0) < 250_000, 'no embedded PNG duplication');
  assert.ok(files.reduce((sum, name) => sum + statSync(join(root, name)).size, 0) < 55_000_000, 'batch below 55 MB');
});

test('demo sources are unchanged and every delivered file has an exact inventory byte count', () => {
  assert.equal(hash(read('agentroid-demo.gif')), 'eeaaf7adb3325e95b14305d305fc412133146a8f72d84257eb535946f37cb05d');
  assert.equal(hash(read('agentroid-demo-still.png')), '8280901c74ccef93b59d4907a30fd248b6c01af68bf3acaef5f9a4026bdc014e');
  assert.equal(hash(read('reddit-pull-demo.svg')), 'b8e803dd35650891a63790fbc365a39724ae3a72709b6bf7ff0e748b7f5bddae');
  assert.deepEqual(read('reddit-pull-demo.svg'), readFileSync(join(root, '../../tools/research/reddit-pull/docs/demo.svg')));
  const inventory = read('INDEX.md').toString();
  const entries = [...inventory.matchAll(/^\| \[([^\]]+)\]\(\1\) \|.*?\/ ([\d,]+) bytes \|/gm)];
  assert.deepEqual(entries.map(entry => entry[1]).sort(), [...files].sort());
  for (const [, name, bytes] of entries) assert.equal(statSync(join(root, name)).size, Number(bytes.replaceAll(',', '')), name);
});
